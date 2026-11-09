# Recette des écritures à blanc (chantier 35)

Point 35.5, sur un A-I-D connecté au vrai mesh. Les cases restent à cocher sur place. Garder les relevés privés localement ; cette fiche n'accueille ni configuration, ni contenu réel, ni adresse. Les exemples `peer-a`, `peer-b` et `#1234` sont génériques, à remplacer localement.

Version swarph : ____________________

## Couverture automatique

`e2e/ecritures-a-blanc.spec.ts` utilise un daemon isolé et le faux swarph : note avec rappel d'obligation ouverte, réponse à un DM, post de canal, refus de nettoyage et de schéma, absence de bouton « Envoyer » et journal sans commande d'écriture. Les fixtures partagées restent intactes. La copie est couverte par les tests web ; l'e2e ne dépend pas du presse-papiers Chromium headless.

## Avant tout

- [ ] Exécuter `aid doctor` et vérifier le diagnostic du mesh.
- [ ] Exécuter `swarph --version` : la version doit être **au moins 0.72.47**. La noter ci-dessus.
- [ ] Vérifier que la cell configurée est celle attendue (exemple : `peer-a`), que le mesh fonctionne et qu'un DM réel de `peer-b` est disponible. Ne recopier aucune configuration.
- [ ] Choisir une carte réelle et un canal autorisé ; relever localement l'heure de début et le fil de la carte avec `swarph board cards show 1234 --json --as peer-a` ou la lecture du fil. Conserver le relevé localement.

## Note sur une carte réelle

- [ ] Ouvrir la fiche de la carte, puis « Écrire une note (à blanc) ». Saisir un texte neutre et choisir un kind.
- [ ] Cliquer « Voir l'aperçu » : vérifier le résumé, `board cards say`, `--content-file FICHIER`, le kind, la cell et le texte exact dans son bloc séparé.
- [ ] Comparer la commande affichée à `swarph board cards say --help` : position de l'identifiant et options correctes, sans exécuter la commande d'écriture.
- [ ] Vérifier le bandeau « À blanc : rien n'est parti » et l'absence de tout bouton « Envoyer ».
- [ ] Si la cell détient une obligation ouverte sur cette carte, vérifier son rappel et la mention que la note ne la clôt pas ; l'aperçu reste permis. Sinon noter « non exercé », sans créer d'obligation pour cette recette.

## DM et canal

- [ ] Dans la Boîte, ouvrir « Répondre (à blanc) » sur un vrai DM : le pair est son émetteur et le kind vaut `answer`.
- [ ] Saisir une réponse neutre et lire l'aperçu : `mesh send`, bon pair, texte exact et bandeau à blanc. Fermer sans rien lancer.
- [ ] À l'écran Swarph, ouvrir « Écrire au mesh (à blanc) », choisir « Canal » et saisir le nom du canal autorisé.
- [ ] Saisir un texte neutre et lire l'aperçu : `channel post`, bon canal, texte exact et rappel de tous les membres du canal. Vérifier le bandeau à blanc et l'absence de bouton « Envoyer » dans ces deux parcours.

## Refus et copie

- [ ] Remplacer le texte par une fausse clé `sk-ant-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` : l'aperçu est refusé, le message nomme la classe sans recopier la clé. Ne jamais employer de vraie clé.
- [ ] Revenir à un texte neutre, saisir un canal invalide contenant une espace : le refus de schéma s'affiche à la place de l'aperçu.
- [ ] Rétablir un aperçu valide, cliquer « Copier la commande », puis coller dans un éditeur de texte : la commande garde `FICHIER`. Ne pas la coller dans un terminal.
- [ ] Cliquer « Copier le texte » et coller dans l'éditeur : le texte correspond exactement au bloc d'aperçu. Effacer les copies après comparaison.

**La commande s'exécute avec tous les droits de la cell. La recette ne la lance pas.** Pour une utilisation ultérieure, il faudrait écrire le texte dans un fichier et remplacer `FICHIER` par son chemin ; ne pas effectuer cet envoi pendant la recette.

## Preuve que rien n'est parti

- [ ] Après les trois aperçus, attendre un intervalle observable (par exemple une minute) et relever localement l'heure de fin. Relire la même carte avec `swarph board cards show 1234 --json --as peer-a` ou la lecture du fil : aucun nouveau message de la cell sur l'intervalle début–fin.
- [ ] Relire le DM et le canal sur le même intervalle : aucun nouveau message de la cell correspondant aux textes de recette. En cas d'activité concurrente, noter la comparaison inconclusive et recommencer dans une période calme.
- [ ] Inspecter localement le journal du daemon sur cet intervalle : aucun des textes saisis, ni commande d'écriture `cards say`, `mesh send` ou `channel post`. Ne recopier aucune ligne privée ici. Si le journal n'est pas accessible, noter « non vérifiable ».

## Mode host

- [ ] Depuis un appareil appairé, dans sa session authentifiée de mode host, effectuer une requête `POST /api/swarph/ecrire/apercu` avec un corps synthétique valide, par exemple `{"action":"dm.envoyer","params":{"pair":"peer-b","kind":"answer","texte":"Essai à blanc","fil":null}}`. Vérifier que la route n'est pas servie (404), sans aperçu. Un simple refus d'authentification ne suffit pas à valider cette case. Ne copier ni jeton ni adresse dans la fiche.

Constats, intervalle observé et cases non exercées (sans contenu privé) : ____________________
