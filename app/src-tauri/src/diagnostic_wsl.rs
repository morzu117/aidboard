// Logique pure du diagnostic ; les sorties ambiguës laissent le démarrage continuer.
const ABSENT: &str = "WSL2 n'est pas installé. Dans un terminal administrateur : `wsl --install -d Ubuntu`, redémarre Windows, puis relance AID.";

pub fn distribution(nom: &str) -> Result<&str, String> {
    if nom.trim().is_empty() || nom.chars().any(char::is_control) {
        Err("AID_WSL_DISTRO doit contenir un nom non vide, sans caractère de contrôle.".into())
    } else {
        Ok(nom)
    }
}

pub fn decoder(octets: &[u8]) -> Option<String> {
    if octets.len() % 2 != 0 { return None; }
    let unites: Vec<u16> = octets.chunks_exact(2)
        .map(|paire| u16::from_le_bytes([paire[0], paire[1]]))
        .collect();
    let unites = unites.strip_prefix(&[0xfeff]).unwrap_or(&unites);
    String::from_utf16(unites).ok()
}

#[derive(Debug, PartialEq)]
struct Distribution {
    nom: String,
    version: u8,
    defaut: bool,
}

fn analyser(texte: &str) -> Option<Vec<Distribution>> {
    let mut lignes = texte.lines().map(str::trim).filter(|ligne| !ligne.is_empty());
    let entete = lignes.next()?;
    if entete.split_whitespace().last()? != "VERSION" { return None; }
    let mut distributions = Vec::new();
    for ligne in lignes {
        let defaut = ligne.starts_with('*');
        let ligne = ligne.strip_prefix('*').unwrap_or(ligne).trim();
        let (reste, version) = ligne.rsplit_once(char::is_whitespace)?;
        let version = version.parse::<u8>().ok()?;
        if version != 1 && version != 2 { return None; }
        // WSL aligne les colonnes par plusieurs espaces ; l'état peut être localisé.
        let reste = reste.trim_end();
        let (nom, _etat) = reste.rsplit_once("  ")
            .or_else(|| reste.rsplit_once(char::is_whitespace))?;
        let nom = distribution(nom.trim_end()).ok()?.to_string();
        distributions.push(Distribution { nom, version, defaut });
    }
    Some(distributions)
}

pub fn message(texte: &str, cible: Option<&str>) -> Option<String> {
    if texte.contains("Windows Subsystem for Linux has no installed distributions")
        || texte.contains("aucune distribution installée")
        || texte.contains("aucune distribution n’est installée")
    {
        return Some(ABSENT.into());
    }
    let distributions = analyser(texte)?;
    if distributions.is_empty() { return Some(ABSENT.into()); }
    let visee = match cible {
        Some(nom) => match distributions.iter().find(|d| d.nom == nom) {
            Some(d) => d,
            None => return Some(format!("La distribution {nom} est introuvable. Distributions présentes : {}.",
                distributions.iter().map(|d| d.nom.as_str()).collect::<Vec<_>>().join(", "))),
        },
        None => distributions.iter().find(|d| d.defaut)?,
    };
    (visee.version == 1).then(|| format!("La distribution {} tourne en WSL1. AID Server demande WSL2 : `wsl --set-version {} 2`, puis relance AID.", visee.nom, visee.nom))
}

#[cfg(target_os = "windows")]
pub fn verifier() -> Result<(), String> {
    let cible = std::env::var("AID_WSL_DISTRO")
        .map(Some).or_else(|erreur| match erreur {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err("AID_WSL_DISTRO est illisible.".to_string()),
        })?;
    let cible = cible.as_deref().map(distribution).transpose()?;
    let sortie = match std::process::Command::new("wsl.exe").args(["--list", "--verbose"]).output() {
        Ok(sortie) => sortie,
        Err(erreur) if erreur.kind() == std::io::ErrorKind::NotFound => return Err(ABSENT.into()),
        Err(_) => return Ok(()),
    };
    // WSL renvoie aussi un échec lorsqu'aucune distribution n'est installée.
    let texte = decoder(&sortie.stdout);
    if texte.as_deref().and_then(|texte| message(texte, cible)).as_deref() == Some(ABSENT) {
        return Err(ABSENT.into());
    }
    if !sortie.status.success() { return Ok(()); }
    if let Some(message) = decoder(&sortie.stdout).and_then(|texte| message(&texte, cible)) {
        return Err(message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const LISTE: &str = "  NAME STATE VERSION\r\n* Ubuntu Test Running 2\r\n  Debian Stopped 1\r\n";

    #[test]
    fn decodage_utf16() {
        for prefixe in [vec![], vec![0xff, 0xfe]] {
            let mut octets = prefixe;
            octets.extend(LISTE.encode_utf16().flat_map(u16::to_le_bytes));
            assert_eq!(decoder(&octets).as_deref(), Some(LISTE));
        }
        let accents: Vec<u8> = "État arrêté".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decoder(&accents).as_deref(), Some("État arrêté"));
        assert_eq!(decoder(&[0]), None);
        assert_eq!(decoder(&[0x00, 0xd8]), None);
    }

    #[test]
    fn liste_et_messages() {
        let liste = analyser(LISTE).unwrap();
        assert_eq!(liste[0], Distribution { nom: "Ubuntu Test".into(), version: 2, defaut: true });
        assert_eq!(liste[1].version, 1);
        assert_eq!(message("NAME STATE VERSION\n* Ubuntu Test    En cours d’exécution    2", None), None);
        assert_eq!(message("Windows Subsystem for Linux has no installed distributions.", None).as_deref(), Some(ABSENT));
        assert_eq!(message(LISTE, None), None);
        assert!(message("NAME STATE VERSION\n* Ubuntu Running 1", None).unwrap().contains("tourne en WSL1"));
        assert_eq!(message(LISTE, Some("Debian")).unwrap(), "La distribution Debian tourne en WSL1. AID Server demande WSL2 : `wsl --set-version Debian 2`, puis relance AID.");
        assert_eq!(message(LISTE, Some("Ubuntu")).unwrap(), "La distribution Ubuntu est introuvable. Distributions présentes : Ubuntu Test, Debian.");
        assert_eq!(message("NAME STATE VERSION\n", None).as_deref(), Some(ABSENT));
        for texte in ["", "illisible", "NAME STATE VERSION\n* Ubuntu Running ?"] {
            assert_eq!(message(texte, None), None);
        }
        for nom in ["", " ", "Ubuntu\n", "Ubuntu\0"] { assert!(distribution(nom).is_err()); }
        assert_eq!(distribution("Ubuntu Test"), Ok("Ubuntu Test"));
    }
}
