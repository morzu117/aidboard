mod daemon_bridge;

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

// Texte de la page d'attente (app/loading/index.html) : étapes de spawn_cycle, puis erreur éventuelle.
fn set_state(window: &tauri::WebviewWindow, message: &str) {
    let _ = window.eval(format!(
        "document.getElementById('etat').textContent = {}",
        serde_json::json!(message)
    ));
}

// Mise à jour d'AID Board par l'updater Tauri (DR10) : `latest.json` publié avec chaque release,
// bundle signé par la clé minisign dont la partie publique est dans tauri.conf.json. Sans
// signature valide, le plugin refuse — c'est voulu, et ça se lit dans le journal. Lancée après
// l'ouverture de la fenêtre principale, jamais avant : le daemon d'abord.
fn check_board_update(app: &tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("mise à jour d'AID Board indisponible : {e}");
            return;
        }
    };
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            log::info!("AID Board à jour");
            return;
        }
        Err(e) => {
            log::warn!("vérification des mises à jour d'AID Board impossible : {e}");
            return;
        }
    };
    let accepted = app
        .dialog()
        .message(format!(
            "AID Board {} est disponible (installée : {}). L'installer et relancer maintenant ? \
             Le daemon et ses agents continuent de tourner.",
            update.version, update.current_version
        ))
        .title("Mise à jour d'AID Board")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Mettre à jour".into(),
            "Plus tard".into(),
        ))
        .blocking_show();
    if !accepted {
        return;
    }
    match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
        // Windows : l'installateur relance lui-même l'app ; macOS et Linux : à nous.
        Ok(()) => app.restart(),
        Err(e) => log::warn!("mise à jour d'AID Board échouée (signature, réseau…) : {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Fenêtre de chargement affichée tout de suite (app/dist/index.html) : spawn_cycle()
            // peut prendre plusieurs secondes. Remplacée par une vraie fenêtre externe une fois
            // l'URL connue — jamais par un eval(location.replace(...)) sur cette même fenêtre :
            // constaté que WKWebView ne retient pas le cookie de session posé sur la redirection
            // qui suit /?token=... quand la navigation est déclenchée depuis du JS injecté plutôt
            // qu'un vrai chargement d'URL (le daemon, lui, se comporte normalement — rejoué au
            // curl, token échangé puis redirection reconnue avec le cookie). Une vraie fenêtre
            // construite avec WebviewUrl::External évite ce chemin.
            let loading =
                WebviewWindowBuilder::new(app, "loading", WebviewUrl::App("index.html".into()))
                    .title("AID")
                    .inner_size(1200.0, 800.0)
                    .build()?;

            let handle = app.handle().clone();
            daemon_bridge::start_restart_bridge();

            std::thread::spawn(move || {
                let progress = {
                    let loading = loading.clone();
                    move |step: &str| set_state(&loading, step)
                };
                let info = match daemon_bridge::spawn_cycle(&progress) {
                    Ok(info) => info,
                    Err(message) => {
                        set_state(&loading, &format!("AID n'a pas pu démarrer : {message}"));
                        return;
                    }
                };
                let url = daemon_bridge::daemon_url(&info);
                let parsed = match url::Url::parse(&url) {
                    Ok(u) => u,
                    Err(e) => {
                        set_state(&loading, &format!("URL du daemon invalide : {e}"));
                        return;
                    }
                };
                let built =
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(parsed))
                        .title("AID")
                        .inner_size(1200.0, 800.0)
                        .build();
                match built {
                    Ok(_) => {
                        let _ = loading.close();
                        check_board_update(&handle);
                    }
                    Err(e) => {
                        set_state(&loading, &format!("AID n'a pas pu ouvrir la fenêtre : {e}"))
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
