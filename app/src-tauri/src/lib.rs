mod daemon_bridge;

use tauri::{WebviewUrl, WebviewWindowBuilder};

// Texte de la page d'attente (app/loading/index.html) : étapes de spawn_cycle, puis erreur éventuelle.
fn set_state(window: &tauri::WebviewWindow, message: &str) {
    let _ = window.eval(format!(
        "document.getElementById('etat').textContent = {}",
        serde_json::json!(message)
    ));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
