use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const BUDGET: Duration = Duration::from_secs(10);
const DELAI: Duration = Duration::from_secs(2);
const PAUSE: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq)]
enum Decision {
    Reessayer(Duration),
    Termine(Result<(), String>),
}

// Décision pure : ni horloge, ni réseau, ni plateforme implicite.
fn decider(port: u16, windows: bool, essais: u32, ecoule: Duration, joignable: bool) -> Decision {
    if joignable {
        return Decision::Termine(Ok(()));
    }
    if essais < 10 && ecoule < BUDGET {
        return Decision::Reessayer(DELAI.min(BUDGET - ecoule));
    }
    let message = if windows {
        format!("AID Server tourne dans WSL2, mais Windows n'arrive pas à joindre 127.0.0.1:{port}. Vérifie le transfert localhost de WSL : dans %UserProfile%\\.wslconfig, `localhostForwarding=true` (ou `networkingMode=mirrored`), puis `wsl --shutdown` et relance AID.")
    } else {
        format!("AID Server a démarré, mais 127.0.0.1:{port} ne répond pas. Voir ~/.aid/daemon.log.")
    };
    Decision::Termine(Err(message))
}

fn sonder(port: u16, delai: Duration) -> std::io::Result<bool> {
    let debut = Instant::now();
    let restant = || delai.checked_sub(debut.elapsed()).filter(|d| !d.is_zero())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "délai de connexion écoulé"));
    let adresse = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut flux = TcpStream::connect_timeout(&adresse, restant()?)?;
    flux.set_write_timeout(Some(restant()?))?;
    write!(flux, "HEAD / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")?;
    // Ne lire que la ligne de statut, bornée même si le serveur envoie au compte-gouttes.
    let mut ligne = Vec::new();
    for _ in 0..128 {
        flux.set_read_timeout(Some(restant()?))?;
        let mut octet = [0];
        flux.read_exact(&mut octet)?;
        ligne.push(octet[0]);
        if octet[0] == b'\n' {
            return Ok(ligne.starts_with(b"HTTP/1.")
                && ligne.get(7).is_some_and(u8::is_ascii_digit)
                && ligne.get(8) == Some(&b' ')
                && ligne.get(9..12).is_some_and(|code| code.iter().all(u8::is_ascii_digit))
                && matches!(ligne.get(12), Some(b' ' | b'\r' | b'\n')));
        }
    }
    Ok(false)
}

pub fn verifier(port: u16) -> Result<(), String> {
    let debut = Instant::now();
    let mut essais = 0;
    let mut joignable = false;
    loop {
        match decider(port, cfg!(target_os = "windows"), essais, debut.elapsed(), joignable) {
            Decision::Termine(resultat) => return resultat,
            Decision::Reessayer(delai) => {
                joignable = sonder(port, delai).unwrap_or(false);
                essais += 1;
                if !joignable {
                    std::thread::sleep(PAUSE.min(BUDGET.saturating_sub(debut.elapsed())));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn decisions_et_messages() {
        assert_eq!(decider(4870, true, 0, Duration::ZERO, false), Decision::Reessayer(DELAI));
        assert_eq!(decider(4870, false, 1, BUDGET - Duration::from_millis(1), false), Decision::Reessayer(Duration::from_millis(1)));
        assert_eq!(decider(4870, true, 1, Duration::ZERO, true), Decision::Termine(Ok(())));
        for (windows, attendu) in [(true, "AID Server tourne dans WSL2, mais Windows n'arrive pas à joindre 127.0.0.1:4870. Vérifie le transfert localhost de WSL : dans %UserProfile%\\.wslconfig, `localhostForwarding=true` (ou `networkingMode=mirrored`), puis `wsl --shutdown` et relance AID."), (false, "AID Server a démarré, mais 127.0.0.1:4870 ne répond pas. Voir ~/.aid/daemon.log.")] {
            for (essais, ecoule) in [(10, Duration::ZERO), (1, BUDGET)] {
                assert_eq!(decider(4870, windows, essais, ecoule, false), Decision::Termine(Err(attendu.into())));
            }
        }
    }

    #[test]
    fn serveur_local_et_statuts_http() {
        for (statut, attendu) in [(200, true), (401, true), (404, true), (503, true)] {
            let serveur = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = serveur.local_addr().unwrap().port();
            let tache = std::thread::spawn(move || {
                let (mut flux, _) = serveur.accept().unwrap();
                flux.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut requete = Vec::new();
                while !requete.ends_with(b"\r\n\r\n") {
                    let mut octet = [0];
                    flux.read_exact(&mut octet).unwrap();
                    requete.push(octet[0]);
                }
                assert!(requete.starts_with(b"HEAD / HTTP/1.1\r\n"));
                assert!(!String::from_utf8(requete).unwrap().to_ascii_lowercase().contains("authorization:"));
                write!(flux, "HTTP/1.1 {statut} Test\r\nContent-Length: 0\r\n\r\n").unwrap();
            });
            let joignable = sonder(port, Duration::from_secs(2)).unwrap();
            assert_eq!(joignable, attendu);
            let decision = decider(port, false, 1, BUDGET, joignable);
            if attendu {
                assert_eq!(decision, Decision::Termine(Ok(())));
            } else {
                assert!(matches!(decision, Decision::Termine(Err(_))));
            }
            tache.join().unwrap();
        }
    }

    #[test]
    fn serveur_silencieux_borne_par_le_delai() {
        let serveur = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = serveur.local_addr().unwrap().port();
        // Le listener reste ouvert sans répondre : la connexion TCP seule ne suffit pas.
        let debut = Instant::now();
        assert!(!sonder(port, Duration::from_millis(50)).unwrap_or(false));
        assert!(debut.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn port_ferme() {
        let serveur = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = serveur.local_addr().unwrap().port();
        drop(serveur);
        assert!(!sonder(port, DELAI).unwrap_or(false));
        assert!(matches!(decider(port, true, 10, BUDGET, false), Decision::Termine(Err(_))));
    }
}
