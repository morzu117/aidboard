// Fait ce que faisait macapp/AID.applescript (chantier précédent), en cross-platform : résout le
// binaire AID Server (DR11), l'installe au besoin (DR9), lance `aid --cycle`, lit ~/.aid/daemon.json
// (contrat déjà défini par src/cli/daemonInfo.ts), construit l'URL à afficher, et expose un pont de
// redémarrage pour le CTA de la coquille hors-ligne (web/src/ecrans/Accueil.tsx) — cette dernière
// est servie par le daemon, pas par Tauri, donc hors de portée de l'IPC Tauri (qui ne s'injecte que
// dans l'origine interne de l'app).
//
// Toute la résolution se fait dans un shell de login (zsh sur macOS/Linux, bash dans WSL2 sous
// Windows) : c'est lui qui connaît le PATH de l'utilisateur (mise, ~/.local/bin…), et c'est là que
// vivent `aid`, `curl` et `sh` dans tous les cas — sous Windows, le daemon n'existe que dans WSL2.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;

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

// Échappement shell minimal, même rôle que `quoted form of` dans l'ancien AID.applescript.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Installeur d'AID Server publié avec chaque release (DR9) — le même que pour un humain.
/// `AID_SERVER_INSTALL_URL` (lu par le shell) permet de pointer un miroir ou un serveur local.
pub const INSTALL_SCRIPT_URL: &str =
    "https://github.com/morzu117/aidboard/releases/latest/download/install-server.sh";

// Ordre de résolution DR11 : AID_SERVER_BIN (pour tester), ~/.aid/server/current/bin/aid (installé
// par install-server.sh), puis `aid` sur le PATH (mode développeur : le clone lié par npm link).
// Écrit en sh POSIX, exécuté par le shell de login : imprime le chemin ou sort en 1.
const RESOLVE_SCRIPT: &str = r#"bin=${AID_SERVER_BIN:-}
home=${AID_HOME:-$HOME/.aid}
if [ -z "$bin" ] && [ -x "$home/server/current/bin/aid" ]; then bin="$home/server/current/bin/aid"; fi
if [ -z "$bin" ]; then bin=$(command -v aid 2>/dev/null) || exit 1; fi
[ -n "$bin" ] && [ -x "$bin" ] || exit 1
printf '%s\n' "$bin"
"#;

fn bootstrap_script() -> String {
    format!("curl -fsSL \"${{AID_SERVER_INSTALL_URL:-{INSTALL_SCRIPT_URL}}}\" | sh")
}

fn cycle_shell_command(bin: &str) -> String {
    format!("AID_NO_BROWSER=1 {} --cycle", shell_quote(bin))
}

// Le shell de login de la plateforme : `-i -l` pour que zsh lise ~/.zshrc (c'est là que mise et
// les PATH utilisateur sont posés) ; dans WSL2, `bash -lc` fait pareil avec ~/.profile.
#[cfg(not(target_os = "windows"))]
fn login_shell(script: &str) -> Command {
    let mut c = Command::new("/bin/zsh");
    c.args(["-i", "-l", "-c", script]);
    c
}

#[cfg(target_os = "windows")]
fn login_shell(script: &str) -> Command {
    let mut c = Command::new("wsl.exe");
    c.args(["-e", "bash", "-lc", script]);
    c
}

#[cfg(not(target_os = "windows"))]
const WHERE: &str = "";
#[cfg(target_os = "windows")]
const WHERE: &str = " (dans WSL2)";

/// Le binaire AID Server à lancer, ou None s'il n'y en a aucun (DR11).
pub fn resolve_server() -> Option<String> {
    let out = login_shell(RESOLVE_SCRIPT).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let bin = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if bin.is_empty() { None } else { Some(bin) }
}

/// Installe AID Server par l'installeur officiel (`curl … | sh`), comme le ferait un humain.
pub fn bootstrap_server() -> Result<(), String> {
    let status = login_shell(&bootstrap_script())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "install-server.sh a échoué{WHERE} (code {:?}) — curl et sh sont-ils disponibles ?",
            status.code()
        ));
    }
    Ok(())
}

// `aid --cycle` interrompt proprement les agents, met à jour si possible, relance, et n'attend
// que le nouveau daemon réponde avant de rendre la main (src/cli/aid.ts, bloc --cycle) : rien à
// réimplémenter ici, juste attendre la fin du process puis relire daemon.json à froid.
// `on_state` reçoit chaque étape, pour la page d'attente (app/loading/index.html).
pub fn spawn_cycle(on_state: &dyn Fn(&str)) -> Result<DaemonInfo, String> {
    on_state("Recherche d'AID Server…");
    let bin = match resolve_server() {
        Some(bin) => bin,
        None => {
            on_state("Installation d'AID Server…");
            bootstrap_server()?;
            resolve_server().ok_or_else(|| {
                format!("AID Server installé mais introuvable{WHERE} : ~/.aid/server/current/bin/aid absent")
            })?
        }
    };
    log::info!("AID Server : {bin}");
    on_state("Démarrage d'AID Server…");
    let status = login_shell(&cycle_shell_command(&bin))
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "aid --cycle a échoué{WHERE} (code {:?}) — voir ~/.aid/daemon.log{WHERE}",
            status.code()
        ));
    }
    read_daemon_json().ok_or_else(|| "daemon.json introuvable après le cycle".to_string())
}

/// Pont de redémarrage pour le CTA de la coquille hors-ligne. Alternative retenue à l'IPC Tauri
/// (incertain sur une origine distante à port dynamique, sur trois moteurs de WebView différents) :
/// un fetch() ordinaire, comme le reste du client web.
pub fn start_restart_bridge() {
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
            thread::spawn(move || handle_restart_request(stream));
        }
    });
}

fn handle_restart_request(mut stream: TcpStream) {
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
        if let Err(message) = spawn_cycle(&|step| log::info!("redémarrage : {step}")) {
            log::warn!("redémarrage demandé depuis la page a échoué : {message}");
        }
    });
}
