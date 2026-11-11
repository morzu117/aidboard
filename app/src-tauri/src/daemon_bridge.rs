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
    let out = login_shell(LECTURE_DAEMON_SCRIPT)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_str(sortie_wsl(&out.stdout)?).ok().map(remember_port)
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

fn cycle_shell_command(bin: &str, accord: bool) -> String {
    format!("AID_NO_BROWSER=1 {} --cycle{}", shell_quote(bin), if accord { " --force" } else { "" })
}

// Seul le code 3 indique une mise à jour connue ; aucune erreur ne vaut consentement.
fn accord_cycle(code: Option<i32>, demander: &dyn Fn() -> bool) -> bool {
    code == Some(3) && demander()
}

// Le shell de login de la plateforme : `-i -l` pour que zsh lise ~/.zshrc (c'est là que mise et
// les PATH utilisateur sont posés) ; dans WSL2, bash interactif lit aussi ~/.bashrc.
#[cfg(not(target_os = "windows"))]
fn login_shell(script: &str) -> Command {
    let mut c = Command::new("/bin/zsh");
    c.args(["-i", "-l", "-c", script]);
    c
}

// Le démarrage du shell peut écrire sur stdout ; stderr reste distinct (job control).
#[cfg(any(target_os = "windows", test))]
const MARQUEUR_WSL: &str = "\x1eAID_SORTIE\x1f";
#[cfg(any(target_os = "windows", test))]
const LECTURE_DAEMON_SCRIPT: &str = r#"cat "${AID_HOME:-$HOME/.aid}/daemon.json""#;

#[cfg(any(target_os = "windows", test))]
fn arguments_wsl(script: &str) -> Vec<String> {
    vec![
        "-e".into(),
        "bash".into(),
        "-l".into(),
        "-i".into(),
        "-c".into(),
        format!("printf '%s' '{}'; {}", MARQUEUR_WSL, script),
    ]
}

#[cfg(any(target_os = "windows", test))]
fn arguments_distribution_wsl(script: &str, distribution: Option<&str>) -> Vec<String> {
    let mut arguments = Vec::new();
    if let Some(nom) = distribution {
        arguments.extend(["-d".into(), nom.into()]);
    }
    arguments.extend(arguments_wsl(script));
    arguments
}

#[cfg(any(target_os = "windows", test))]
fn sortie_wsl(sortie: &[u8]) -> Option<&str> {
    std::str::from_utf8(sortie)
        .ok()?
        .split_once(MARQUEUR_WSL)
        .map(|(_, utile)| utile)
}

#[cfg(target_os = "windows")]
fn login_shell(script: &str) -> Command {
    let mut c = Command::new("wsl.exe");
    let distribution = std::env::var("AID_WSL_DISTRO").ok();
    c.args(arguments_distribution_wsl(script, distribution.as_deref()));
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
    #[cfg(target_os = "windows")]
    let bin = sortie_wsl(&out.stdout)?.trim().to_string();
    #[cfg(not(target_os = "windows"))]
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

// `aid --cycle` réutilise le daemon et rend 3 si une mise à jour attend un accord.
// `on_state` reçoit chaque étape, pour la page d'attente (app/loading/index.html).
pub fn spawn_cycle(on_state: &dyn Fn(&str), demander: &dyn Fn() -> bool) -> Result<DaemonInfo, String> {
    #[cfg(target_os = "windows")]
    {
        on_state("Vérification de WSL…");
        crate::diagnostic_wsl::verifier()?;
    }
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
    let mut status = login_shell(&cycle_shell_command(&bin, false))
        .status()
        .map_err(|e| e.to_string())?;
    if status.code() == Some(3) {
        if accord_cycle(status.code(), demander) {
            on_state("Mise à jour d'AID Server…");
            status = login_shell(&cycle_shell_command(&bin, true))
                .status()
                .map_err(|e| e.to_string())?;
        } else {
            return read_daemon_json().ok_or_else(|| "daemon.json introuvable".to_string());
        }
    }
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
        if let Err(message) = spawn_cycle(&|step| log::info!("redémarrage : {step}"), &|| false) {
            log::warn!("redémarrage demandé depuis la page a échoué : {message}");
        }
    });
}

#[cfg(test)]
mod tests_wsl {
    use super::*;

    #[test]
    fn choix_du_dialogue() {
        assert!(accord_cycle(Some(3), &|| true));
        assert!(!accord_cycle(Some(3), &|| false));
        for code in [Some(0), Some(1), None] {
            assert!(!accord_cycle(code, &|| panic!("aucun dialogue attendu")));
        }
        assert!(cycle_shell_command("/tmp/aid serveur", true).ends_with(" --cycle --force"));
        assert!(cycle_shell_command("/tmp/aid serveur", false).ends_with(" --cycle"));
    }

    #[test]
    fn shell_interactif_et_sortie_isolee() {
        assert_eq!(arguments_distribution_wsl(RESOLVE_SCRIPT, None), arguments_wsl(RESOLVE_SCRIPT));
        let cible = arguments_distribution_wsl(RESOLVE_SCRIPT, Some("Ubuntu Test"));
        assert_eq!(&cible[..3], ["-d", "Ubuntu Test", "-e"]);
        assert_eq!(&cible[2..], arguments_wsl(RESOLVE_SCRIPT));
        let args = arguments_wsl(RESOLVE_SCRIPT);
        assert_eq!(&args[..5], ["-e", "bash", "-l", "-i", "-c"]);
        assert!(args[5].ends_with(RESOLVE_SCRIPT));
        let bruit = format!("Bienvenue\n{}{}", MARQUEUR_WSL, "/tmp/aid serveur\n");
        assert_eq!(sortie_wsl(bruit.as_bytes()), Some("/tmp/aid serveur\n"));
        assert_eq!(sortie_wsl(b"aucun marqueur"), None);
    }

    #[cfg(unix)]
    #[test]
    fn home_personnalise_et_repli() {
        let dossier = std::env::temp_dir().join(format!("aid-wsl-{}", std::process::id()));
        let personnalise = dossier.join("home avec espaces");
        let defaut = dossier.join(".aid");
        for chemin in [&personnalise, &defaut] {
            std::fs::create_dir_all(chemin).unwrap();
            std::fs::write(
                chemin.join("daemon.json"),
                r#"{"port":4870,"token":"exemple"}"#,
            )
            .unwrap();
        }
        for home in [Some(&personnalise), None] {
            let mut commande = Command::new("bash");
            commande.args([
                "--noprofile", "--norc", "-l", "-i", "-c",
                &arguments_wsl(LECTURE_DAEMON_SCRIPT)[5],
            ]);
            commande.env("HOME", &dossier).env_remove("AID_HOME");
            if let Some(home) = home {
                commande.env("AID_HOME", home);
            }
            let sortie = commande.output().unwrap();
            assert!(sortie.status.success());
            let info: DaemonInfo =
                serde_json::from_str(sortie_wsl(&sortie.stdout).unwrap()).unwrap();
            assert_eq!(info.port, 4870);
        }
        std::fs::remove_dir_all(dossier).unwrap();
    }

    #[test]
    fn lecture_home_et_port_avec_bruit() {
        assert!(arguments_wsl(LECTURE_DAEMON_SCRIPT)[5]
            .ends_with(r#"cat "${AID_HOME:-$HOME/.aid}/daemon.json""#));
        let sortie = format!(
            "message bash\n{}{}", MARQUEUR_WSL,
            r#"{"port":4870,"token":"exemple"}"#,
        );
        let info: DaemonInfo = serde_json::from_str(sortie_wsl(sortie.as_bytes()).unwrap()).unwrap();
        assert_eq!(info.port, 4870);
    }
}
