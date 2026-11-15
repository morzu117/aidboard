# Recette du chantier 46 — Multi-mesh

Sur le Mac et le téléphone. Cocher après observation ; ne recopier aucune
identité, adresse, donnée d'authentification ni erreur réelle dans le compte
rendu. Tous les noms et chemins ci-dessous sont des exemples uniquement.

## D'abord, deux faux meshes

- [ ] Sur une instance de recette isolée, lancer
      `npx playwright test e2e/multi-mesh.spec.ts`, après `npm run build`.
      Poser `TMPDIR` sur un dossier de recette assez grand. Aucun vrai agent,
      gateway ni proxy n'est appelé : deux faux proxies locaux, deux homes,
      un relais local et une passkey virtuelle jouent le parcours.
- [ ] Boîte : deux DM de même id et de même texte apparaissent, chacun avec sa
      pastille `principal` ou `perso`. Ouvrir « Filtrer par mesh » : un seul
      mesh est montré à la fois ; revenir à tous les meshes.
- [ ] Depuis le DM de `perso`, ouvrir « Répondre (à blanc) ». Attendu :
      « Mesh : perso », pair `peer-b`, aperçu sur ce mesh. Envoyer : aucun
      proxy n'a reçu d'écriture avant la confirmation.
- [ ] Téléphone : le bandeau « Mesh : perso » et la cell précèdent le résumé.
      Confirmer avec la passkey virtuelle. Attendu : exactement une écriture
      sur `perso`, aucune sur `principal` ; les journaux des deux faux proxies
      servent de preuve, pas seulement le retour de l'interface.
- [ ] Board : choisir `principal`, puis `perso`, puis `principal` dans le
      sélecteur. La carte de même numéro change de contenu selon le mesh.
- [ ] Avec un seul mesh : ni pastille de nom, ni filtre de mesh dans la Boîte,
      ni sélecteur sur le board ; la barre conserve sa présentation habituelle.

Constats : __________

## Ensuite, deux vrais meshes de recette

Utiliser des données sans conséquence, sous réserve que les pairs nécessaires
soient joignables sur chacun des deux meshes. Ne pas employer les données de
travail pour les essais d'écriture. Configurer chaque proxy séparément, lié à
une seule cell et à son gateway, sous un uid différent de celui d'A-I-D ; les
parents des sockets ne sont pas inscriptibles par l'uid d'A-I-D.

### La configuration

Forme de `config.yaml`, avec des valeurs d'exemple seulement. Remplacer les
chemins par des chemins absolus lors de l'installation ; `~/exemple/` indique
ici le dossier personnel de l'utilisateur, pas une valeur à copier telle quelle.
Le même nom de cell sur les deux meshes est volontaire : leurs homes diffèrent.
`bin` et `tailscale` restent globaux dans `mesh`, sans `cell` dans cette section.

```yaml
mesh:
  bin: ~/exemple/bin/swarph
  tailscale:
    manage: false
    bin: ~/exemple/bin/tailscale
meshes:
  principal:
    cell: peer-a
    gateway: https://aid-e2e.ts.net
    home: ~/exemple/principal
    stateRoot: ~/exemple/principal/swarph_state
    cellFile: ~/exemple/principal/.config/swarph/cells/peer-a.yaml
    inboxLog: ~/exemple/principal/swarph_state/peer-a/mesh-sidecar/inbox.log
    proxySocket: ~/exemple/proxies/principal.sock
    proxyLectureSeule: false
  perso:
    cell: peer-a
    gateway: https://example.com
    home: ~/exemple/perso
    stateRoot: ~/exemple/perso/swarph_state
    cellFile: ~/exemple/perso/.config/swarph/cells/peer-a.yaml
    inboxLog: ~/exemple/perso/swarph_state/peer-a/mesh-sidecar/inbox.log
    proxySocket: ~/exemple/proxies/perso.sock
    proxyLectureSeule: false
```

- [ ] Démarrer : l'interface écoute sans attendre la réponse des monitors.
      Chaque mesh affiche ensuite son propre état. Un mesh en panne ne bloque
      ni l'ouverture du cockpit ni les lectures de l'autre.
- [ ] Vérifier que les homes, jetons, fichiers de cell, dossiers d'état et
      boîtes sont distincts. Ne jamais copier ni lier les identifiants de
      l'agent ou les jetons entre les deux homes.
- [ ] Toute vérification manuelle par le proxy nomme son socket, par exemple
      `swarph proxy call --socket ~/exemple/proxies/perso.sock` suivi du verbe
      et des arguments prévus par le CLI installé. Aucun appel implicite au
      socket par défaut.

Constats : __________

### Les écrans de lecture

- [ ] Barre : une pastille d'état par mesh actif ; la panne d'un mesh n'altère
      pas la pastille de l'autre. Réglages : vérifier l'état et la connexion
      de chaque mesh ; une déconnexion nomme la cell avant confirmation.
- [ ] Boîte : faire envoyer un DM par `peer-b` sur chaque mesh. Vérifier les
      deux pastilles, le tri chronologique et le filtre replié par défaut.
      Marquer « Vu » sur l'un laisse le message de l'autre inchangé, même si
      leurs ids sont identiques. Ne pas forcer une collision sur un gateway réel.
- [ ] Board et fiche de carte : changer le sélecteur, observer les cartes,
      responsables, fils et obligations propres au mesh ; revenir à l'écran
      pour vérifier que la sélection est gardée.
- [ ] Cells, fédération, canaux et mémoire : changer le sélecteur sur chaque
      écran ; seules les données du mesh choisi apparaissent. Les sélections
      sont propres à chaque écran, sans bascule automatique d'un formulaire.
- [ ] Salles d'avis : sur un mesh sans proxy (limite ci-dessous), vérifier que
      les salles, sièges et cartes citées appartiennent au mesh sélectionné.
- [ ] Avec l'ancienne configuration `mesh: { cell, … }` seule, vérifier le même
      affichage qu'avant : aucun sélecteur ni filtre ou pastille de nom ajouté.

Constats : __________

### Les écritures et le téléphone

- [ ] Appairer le téléphone, activer sa passkey après comparaison des
      empreintes, vérifier les confirmations armées. Garder Mac et téléphone
      ouverts pendant la relève du daemon.
- [ ] Répondre à un DM de `perso` sans fil : le formulaire et l'aperçu nomment
      `perso`. Le panneau Confirmations du Mac et le téléphone montrent ce même
      mesh ; le bandeau du téléphone précède le résumé. Avant confirmation,
      aucune écriture. Après confirmation, `peer-b` reçoit une seule réponse
      sur `perso`, rien sur `principal`. Un DM dans un fil reste refusé par le
      proxy actuel ; ne pas contourner ce refus.
- [ ] Refaire puis refuser : aucune écriture sur aucun mesh. Pour un résultat
      incertain, relire le mesh visé avant de réessayer.
- [ ] Note de carte, changement d'état, avis : vérifier le mesh de l'objet
      dans l'aperçu et la demande signée. Changer de mesh vide la cible.
      Ni pair, ni carte, ni siège d'un autre mesh ne doit être repris.
- [ ] Agent PTY de `perso` : le connecter une fois sous son home isolé si
      nécessaire. Sur macOS, vérifier l'effet du trousseau. Vérifier ensuite
      les lectures sous ce home sans rétablir le HOME du daemon.
- [ ] Sur une copie de recette uniquement, rebrancher un nom vers un autre
      couple cell/gateway : mesh inactif, erreur `rebranche`, aucune écriture.
      « Archiver les anciennes données » demande confirmation ; l'ancien jeu
      reste archivé en lecture seule et le nouveau démarre vide.

Constats : __________

## Limites connues

- **D317 (Q-J1, (a))** : les agents d'A-I-D tournent sous le même uid pour
  tous les meshes. Un proxy par cell n'empêche pas un agent de joindre le
  proxy d'un autre mesh. Le cloisonnement du code d'A-I-D ne fournit pas une
  frontière entre ces agents ; un uid par mesh reste hors de ce chantier.
- **Sur un mesh sans proxy**, le jeton de la cell est un fichier sous le
  `home` de ce mesh, lisible par l'uid d'A-I-D et donc par ses agents. Les avis
  sur un mesh exigent aujourd'hui ce mode ; leur relais par le proxy viendra
  avec le ticket swarph #1581.
- **L'agent PTY d'un second mesh démarre déconnecté**, puisque son HOME est
  le `home` du mesh : il faut le connecter une fois dans ce home. Sur macOS,
  la connexion peut passer par le trousseau. Ne jamais refaire pointer ce
  home vers celui du daemon.
- **Si le test `--version` d'un mesh échoue** avec un shim nvm, asdf ou pyenv,
  pointer `bin`, et le CLI de l'agent, vers le vrai exécutable, par exemple
  le chemin versionné que rend `nvm which`. La liste blanche de
  l'environnement ne s'élargit pas.
- **Un appel à `swarph proxy call`** passe toujours `--socket`.
- **Les ids de DM** ne sont uniques que dans un gateway ; une restauration
  du gateway n'est pas vérifiée.

Constats finaux et accord pour la suite : __________
