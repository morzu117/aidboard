// Fait ce que faisait macapp/AID.applescript (chantier précédent), en cross-platform : lance le
// daemon, lit ~/.aid/daemon.json (contrat déjà défini par src/cli/daemonInfo.ts), construit l'URL
// à afficher, et expose un pont de redémarrage pour le CTA de la coquille hors-ligne
// (web/src/ecrans/Accueil.tsx) — cette dernière est servie par le daemon, pas par Tauri, donc hors
// de portée de l'IPC Tauri (qui ne s'injecte que dans l'origine interne de l'app).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;
use tauri::Manager;

/// Port fixe du pont de redémarrage — documenté ici et dans web/src/ecrans/Accueil.tsx, juste
/// au-dessus du port par défaut du daemon (4870, voir README.md).
pub const RESTART_BRIDGE_PORT: u16 = 4871;

// Dernier port connu d'un daemon.json valide, pour tout le process. `aid stop` (et le CTA l'appelle
// précisément quand le daemon est arrêté) supprime daemon.json : à ce moment-là, read_daemon_json()
// seul ne peut plus dire quelle Origin attendre, et le pont refuserait systématiquement la requête
// qu'il existe justement pour traiter. Ce cache, posé par la première lecture réussie (au lancement
// de l'app, via spawn_cycle), reste l'ancrage de confiance tant que l'app tourne.
static LAST_KNOWN_PORT: Mutex<Option<u16>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
}

pub fn daemon_url(info: &DaemonInfo) -> String {
    format!("http://127.0.0.1:{}/?token={}", info.port, info.token)
}

fn aid_home() -> PathBuf {
    if let Ok(home) = std::env::var("AID_HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".aid")
}

// Échappement shell minimal, même rôle que `quoted form of` dans l'ancien AID.applescript.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Chemin du dépôt aidboard installé, écrit par scripts/build.sh dans repo-path.txt (bundlé comme
// resource Tauri). Sur une machine avec plusieurs clones aidboard liés sous des versions mise
// différentes, sans ce `cd` un autre peut répondre à la place sur le PATH — même piège que
// documenté dans l'ancien macapp/AID.applescript.
fn repo_path(app: &tauri::AppHandle) -> Option<String> {
    let resource = app.path().resource_dir().ok()?.join("repo-path.txt");
    std::fs::read_to_string(resource)
        .ok()
        .map(|s| s.trim().to_string())
}

fn remember_port(info: DaemonInfo) -> DaemonInfo {
    *LAST_KNOWN_PORT.lock().unwrap() = Some(info.port);
    info
}

#[cfg(not(target_os = "windows"))]
fn read_daemon_json() -> Option<DaemonInfo> {
    let text = std::fs::read_to_string(aid_home().join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok().map(remember_port)
}

// Le daemon ne tourne jamais en natif sur Windows (README.md) : il vit dans WSL2, donc
// daemon.json aussi. On le lit via WSL plutôt qu'un chemin Windows.
#[cfg(target_os = "windows")]
fn read_daemon_json() -> Option<DaemonInfo> {
    let out = Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", "cat ~/.aid/daemon.json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok().map(remember_port)
}

fn cycle_shell_command(repo: Option<&str>) -> String {
    let mut cmd = String::new();
    if let Some(r) = repo {
        cmd.push_str(&format!("cd {} && ", shell_quote(r)));
    }
    cmd.push_str(
        "command -v aid >/dev/null 2>&1 || { echo 'aid introuvable sur le PATH' >&2; exit 127; }; \
         AID_NO_BROWSER=1 aid --cycle",
    );
    cmd
}

// `aid --cycle` interrompt proprement les agents, met à jour si possible, relance, et n'attend
// que le nouveau daemon réponde avant de rendre la main (src/cli/aid.ts, bloc --cycle) : rien à
// réimplémenter ici, juste attendre la fin du process puis relire daemon.json à froid.
#[cfg(not(target_os = "windows"))]
pub fn spawn_cycle(app: &tauri::AppHandle) -> Result<DaemonInfo, String> {
    let repo = repo_path(app);
    let cmd = cycle_shell_command(repo.as_deref());
    let status = Command::new("/bin/zsh")
        .args(["-i", "-l", "-c", &cmd])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "aid --cycle a échoué (code {:?}) — voir ~/.aid/daemon.log",
            status.code()
        ));
    }
    read_daemon_json().ok_or_else(|| "daemon.json introuvable après le cycle".to_string())
}

#[cfg(target_os = "windows")]
pub fn spawn_cycle(app: &tauri::AppHandle) -> Result<DaemonInfo, String> {
    let repo = repo_path(app);
    let cmd = cycle_shell_command(repo.as_deref());
    let status = Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", &cmd])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "aid --cycle a échoué dans WSL2 (code {:?}) — voir ~/.aid/daemon.log (dans WSL2)",
            status.code()
        ));
    }
    read_daemon_json().ok_or_else(|| "daemon.json introuvable après le cycle".to_string())
}

/// Pont de redémarrage pour le CTA de la coquille hors-ligne. Alternative retenue à l'IPC Tauri
/// (incertain sur une origine distante à port dynamique, sur trois moteurs de WebView différents) :
/// un fetch() ordinaire, comme le reste du client web.
pub fn start_restart_bridge(app: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", RESTART_BRIDGE_PORT)) {
            Ok(l) => l,
            Err(e) => {
                log::warn!("pont de redémarrage indisponible : {e}");
                return;
            }
        };
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            thread::spawn(move || handle_restart_request(stream, app));
        }
    });
}

fn handle_restart_request(mut stream: TcpStream, app: tauri::AppHandle) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    let mut origin: Option<String> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.trim().eq_ignore_ascii_case("origin")
                {
                    origin = Some(value.trim().to_string());
                }
            }
        }
    }

    // Même motif que src/daemon/security.ts : sans cette vérification, n'importe quelle page
    // ouverte ailleurs sur la machine pourrait déclencher un redémarrage du daemon. daemon.json est
    // justement absent le temps où ce bouton sert à quelque chose (daemon arrêté) : repli sur
    // LAST_KNOWN_PORT, posé par la dernière lecture réussie de ce même process.
    let expected_port = read_daemon_json()
        .map(|info| info.port)
        .or_else(|| *LAST_KNOWN_PORT.lock().unwrap());
    let expected_origin = expected_port.map(|port| format!("http://127.0.0.1:{port}"));
    let authorized =
        request_line.starts_with("POST /restart") && origin.is_some() && origin == expected_origin;

    if !authorized {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
    }

    let response = format!(
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {}\r\nContent-Length: 0\r\n\r\n",
        origin.expect("authorized implique origin présent")
    );
    let _ = stream.write_all(response.as_bytes());

    // Répond tout de suite : la relance peut prendre jusqu'à 30 s (voir aid --cycle), la page
    // appelante n'a pas à attendre — elle se reconnectera seule via AidClient une fois le nouveau
    // daemon debout.
    thread::spawn(move || {
        if let Err(message) = spawn_cycle(&app) {
            log::warn!("redémarrage demandé depuis la page a échoué : {message}");
        }
    });
}
