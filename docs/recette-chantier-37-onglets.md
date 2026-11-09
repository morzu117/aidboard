# Recette des onglets swarph en lecture seule (chantier 37)

Point 37.7, à dérouler par Julien sur son Mac, contre son vrai mesh. Les cases de recette réelle restent à cocher sur place. Ne reporter ici aucune donnée privée : conserver les relevés localement.

Version de swarph (`swarph --version`) : ____________________

## Couverture automatique

`e2e/swarph-onglets.spec.ts` parcourt les quatre onglets depuis le Board sur le faux swarph : recherche avec résultat, corps mémoire piégé rendu en texte, navigation entre pages, erreurs Cells et Réglages (`unreachable`), Memory (`forbidden`) et Federation (`no-index`). Les fixtures sont synthétiques.

## Prérequis sur le Mac

- [ ] `aid doctor` et `swarph --version` ont été vérifiés ; noter la version ci-dessus et la révision d'A-I-D localement.
- [ ] Le mesh est connecté, le monitor de `<ta-cellule>` fonctionne, et `~/.aid/config.yaml` configure cette cellule et son gateway. Ne recopier ni configuration ni adresse dans la fiche.
- [ ] Disposer d'une requête connue de l'index local, d'un tag mémoire accessible et d'une page avec un lien vers une autre page.

## Avant le parcours

- [ ] Relever localement `wc -l "<racine-etat>/<ta-cellule>/mesh-sidecar/inbox.log"` (remplacer les formes génériques sur le Mac). Si le fichier manque, noter son absence, sans le créer.
- [ ] Dans le Board, relever localement le projet, les colonnes, les cartes et leurs états, ainsi que l'état lu des messages d'une carte. Ne lancer ni lecture consommatrice de boîte, ni action d'écriture.

## Parcours réel

- [ ] Depuis Board, ouvrir Cells par la barre d'onglets : la cellule locale est en tête, marquée « toi », avec son monitor.
- [ ] Cells affiche les versions déclarées et la note précisant qu'elles datent de la dernière inscription ; ne pas les interpréter comme une preuve de présence.
- [ ] Ouvrir Federation par la barre. Saisir une requête connue : aucune lecture avant « Chercher ». Soumettre et vérifier un résultat de l'index local (nom, dépôt, fichier et ligne, signature, appelants).
- [ ] Si une cellule sans index est déjà disponible et facilement utilisable, y vérifier « Aucun index local […] rien n'a été cherché ». Sinon noter « non exercé » ; ne supprimer aucun index pour provoquer ce cas.
- [ ] Ouvrir Memory, saisir un tag : aucune liste avant « Lister ». Soumettre, ouvrir une page puis suivre un lien entrant ou sortant vers une autre page. Le corps reste du texte, sans HTML exécuté ni URL du corps transformée en lien ; le bandeau de mémoire partagée reste visible.
- [ ] Vérifier localement dans le journal du daemon (`~/.aid/…`, emplacement selon l'installation) que la lecture Memory passe par le gateway configuré. Ne recopier aucune ligne contenant une adresse ou un secret. Si le journal ne permet pas de l'établir, noter « non vérifiable » : la réussite de la page seule ne prouve pas ce chemin.
- [ ] Vérifier l'absence des noms `GBRAIN_TOKEN` et `SWARPH_BRAIN_TOKEN` dans l'environnement du sous-processus **memory**, sans afficher de valeur. Sur macOS, relever son PID pendant une lecture puis exécuter uniquement ce filtre (jamais `ps eww` seul) :

  ```sh
  ps eww -p <pid-memory> -o command= | awk '
    /[G]BRAIN_TOKEN=/ { cerveau = 1 }
    /[S]WARPH_BRAIN_TOKEN=/ { swarph = 1 }
    END {
      print "GBRAIN_TOKEN : " (cerveau ? "nom présent" : "nom absent")
      print "SWARPH_BRAIN_TOKEN : " (swarph ? "nom présent" : "nom absent")
    }'
  ```

  Les deux noms doivent être absents. Confirmer que le PID correspond à un processus memory encore vivant ; s'il disparaît trop vite, noter « non vérifiable » et recommencer sur une lecture, sans conclure depuis une sortie vide. L'environnement du daemon parent seul ne prouve pas celui du sous-processus.

- [ ] Ouvrir Réglages swarph par la barre : vérifier les groupes et droits de la cellule (type, cible, niveau, direct ou hérité), le monitor et les deux mentions « à venir ».
- [ ] Aucun chemin ni aucune adresse n'apparaît dans Réglages swarph.
- [ ] Recharger chaque onglet ; vérifier le rafraîchissement de « Lu à » (soumettre d'abord une requête et un tag pour Federation et Memory).

## Après le parcours : aucune écriture

- [ ] Refaire exactement le relevé `wc -l` du même `inbox.log` : nombre identique, ou absence inchangée. Garder avant/après localement.
- [ ] Recharger le même Board et la même carte : colonnes, cartes, états et état lu des messages identiques aux relevés initiaux. En cas d'activité concurrente du mesh, noter que la comparaison est inconclusive et recommencer dans une période calme.
- [ ] Aucune action d'écriture n'a été utilisée pendant la recette ; ne jamais lancer `swarph mesh inbox`, qui consomme la boîte.

Constats et cases non exercées (sans contenu privé) : ____________________
