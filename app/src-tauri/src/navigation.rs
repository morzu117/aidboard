use tauri::{webview::NewWindowResponse, Runtime, WebviewWindowBuilder};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Decision {
    Rester,
    Ouvrir,
    Refuser,
}

// Une nouvelle fenêtre n'est jamais autorisée, même vers le daemon.
fn decider(adresse: &str, origine: Option<&Url>, nouvelle_fenetre: bool) -> Decision {
    let Ok(url) = Url::parse(adresse) else {
        return Decision::Refuser;
    };
    if !nouvelle_fenetre {
        if let Some(origine) = origine {
            if url.origin() == origine.origin() {
                return Decision::Rester;
            }
        } else if matches!(
            url.as_str(),
            "tauri://localhost/index.html"
                | "http://tauri.localhost/index.html"
                | "https://tauri.localhost/index.html"
        ) {
            return Decision::Rester;
        }
    }
    match url.scheme() {
        "http" | "https" => Decision::Ouvrir,
        _ => Decision::Refuser,
    }
}

fn ouvrir(url: &Url) {
    if let Err(erreur) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        log::warn!("ouverture du navigateur impossible : {erreur}");
    }
}

pub fn proteger<'a, R: Runtime, M: tauri::Manager<R>>(
    fenetre: WebviewWindowBuilder<'a, R, M>,
    origine: Option<Url>,
) -> WebviewWindowBuilder<'a, R, M> {
    fenetre
        .on_new_window(|url, _| {
            if decider(url.as_str(), None, true) == Decision::Ouvrir {
                ouvrir(&url);
            }
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| match decider(url.as_str(), origine.as_ref(), false) {
            Decision::Rester => true,
            Decision::Ouvrir => {
                ouvrir(url);
                false
            }
            Decision::Refuser => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations() {
        let origine = Url::parse("http://127.0.0.1:4870/").unwrap();
        for (adresse, attendu) in [
            ("https://example.com/", Decision::Ouvrir),
            ("http://example.com/", Decision::Ouvrir),
            ("file:///tmp/document", Decision::Refuser),
            ("javascript:alert(1)", Decision::Refuser),
            ("data:text/html,bonjour", Decision::Refuser),
            ("inconnu:document", Decision::Refuser),
            ("http://127.0.0.1:4870/", Decision::Rester),
            ("http://127.0.0.1:4870/?token=exemple", Decision::Rester),
            ("http://127.0.0.1:4870/board", Decision::Rester),
            ("http://127.0.0.1:4871/", Decision::Ouvrir),
            ("http://localhost:4870/", Decision::Ouvrir),
            ("https://127.0.0.1:4870/", Decision::Ouvrir),
            ("http://[", Decision::Refuser),
        ] {
            let nouvelle = if attendu == Decision::Rester {
                Decision::Ouvrir
            } else {
                attendu
            };
            assert_eq!(decider(adresse, Some(&origine), true), nouvelle, "{adresse}");
            assert_eq!(decider(adresse, Some(&origine), false), attendu, "{adresse}");
        }
    }

    #[test]
    fn coquille_embarquee() {
        for adresse in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            assert_eq!(decider(adresse, None, false), Decision::Rester);
            assert_ne!(decider(adresse, None, true), Decision::Rester);
        }
        assert_eq!(
            decider("file:///tmp/index.html", None, false),
            Decision::Refuser
        );
        assert_eq!(decider("adresse invalide", None, false), Decision::Refuser);
    }
}
