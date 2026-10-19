-- Source de AID.app : osacompile (dans scripts/build.sh) la compile à l'installation. L'exécutable
-- compilé n'est pas versionnable comme texte ; cette source, elle, l'est.
--
-- Deux points d'entrée, même logique : un double-clic Finder (`run`) et le schéma `aid://`
-- (`open location`, déclenché par le CTA de la coquille hors-ligne de l'app web). Un script bash
-- ne peut pas recevoir `aid://` : macOS délivre les schémas personnalisés par Apple Event
-- (GetURL), qui exige une vraie boucle d'événements — vérifié en le constatant (argv et env tous
-- deux vides en pratique). Un applet AppleScript compilé en a une, nativement.
on run
  launchAid("")
end run

on open location theURL
  launchAid(theURL)
end open location

on launchAid(theURL)
  -- Avant d'appeler `aid`, se place dans le dépôt installé (Contents/Resources/repo-path.txt,
  -- écrit par scripts/build.sh à l'install) : mise active alors la version de node que ce dépôt
  -- épingle, et c'est CE dépôt qui répond sur le PATH — sans ce `cd`, un autre aidboard lié
  -- globalement sur la machine (sous une autre version de node) peut passer devant.
  set repoFile to (POSIX path of (path to me)) & "Contents/Resources/repo-path.txt"
  set cdPrefix to ""
  try
    set repoPath to do shell script "cat " & quoted form of repoFile
    set cdPrefix to "cd " & quoted form of repoPath & " && "
  end try

  -- Invoqué via aid://start plutôt qu'un double-clic Finder : l'onglet d'origine se reconnecte
  -- déjà tout seul une fois le daemon relancé (cookie de session conservé d'un redémarrage à
  -- l'autre) — ouvrir un second onglet en plus serait une surprise, pas une aide.
  set noBrowserPrefix to ""
  if theURL starts with "aid:" then set noBrowserPrefix to "AID_NO_BROWSER=1 "

  try
    do shell script "/bin/zsh -i -l -c " & quoted form of (cdPrefix & "command -v aid") & " >/dev/null 2>&1"
  on error
    display alert "AID introuvable" message "La commande aid n’est pas sur le PATH (npm link manquant ou mise non initialisé)." as critical
    return
  end try

  try
    do shell script "/bin/zsh -i -l -c " & quoted form of (cdPrefix & noBrowserPrefix & "aid --cycle")
  on error
    display alert "AID n’a pas pu démarrer" message "Voir ~/.aid/daemon.log pour le détail." as critical
  end try
end launchAid
