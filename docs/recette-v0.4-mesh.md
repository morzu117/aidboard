# Recette du mesh swarph (chantier 12)

Grille du point 12.7 du plan `docs/chantiers/12-mesh-swarph.md`. Deux niveaux :

- **couverture automatique** — ce que `npm run gate` et `npm run gate:e2e` vérifient déjà sur
  le même chemin, avec les faux binaires `test/fixtures/fake-swarph.sh` et
  `test/fixtures/fake-tailscale.sh` (D40). Jamais le vrai swarph, jamais Tailscale, aucun
  réseau, jamais un token.
- **recette manuelle** — le vrai mesh de peer-a, à dérouler par Julien sur le Mac. Aucune
  case de cette partie ne peut être cochée depuis une session automatisée : elle exige la
  cell `morzu-mac` enrôlée auprès du gateway `mesh-gw` et un pair qui lui écrit.

## Prérequis humains (12.0) — tous à faire avant la recette manuelle

État constaté sur le Mac le 2026-10-20 : swarph absent, Tailscale installé mais arrêté,
aucune cell ni token.

- [ ] `uv tool install --python 3.12 swarph-cli` ; `swarph --version` répond (≥ 0.72)
- [ ] Tailscale démarré et connecté au tailnet `example.ts.net` (`mesh-gw` dans les pairs)
- [ ] Onboarding de la cell `morzu-mac` auprès de peer-a : token déposé par swarph dans
  `~/.config/swarph/morzu-mac.peer_token` (A-I-D ne le lit jamais), `swarph init morzu-mac`
  a produit `~/.config/swarph/cells/morzu-mac.yaml`
- [ ] Monitor du VPS relancé (`swarph monitor start --as morzu-vps --deliver pull`, sur le
  VPS) : sans lui, `morzu-vps` reste sourd et ne peut pas répondre à `morzu-mac`
- [ ] `~/.aid/config.yaml` :

  ```yaml
  mesh:
    cell: morzu-mac
    gateway: http://mesh-gw.example.ts.net:8788
  ```

  (`bin`, `cellFile`, `stateRoot` restent dérivés ; `tailscale.manage` reste `false` — D37 :
  `tailscale down` couperait `ssh vps`)

- [ ] `aid doctor` : les cinq lignes mesh sont vertes (swarph trouvé, cell lisible, token
  présent, gateway configuré, Tailscale connecté) — couverture automatique :
  `test/doctor.test.ts`

## Poste : macOS (M5) — recette manuelle

- [ ] 12.a Hors mesh : la pastille de la barre dit « hors mesh » (gris), le bouton est actif
  tant que Tailscale tourne ; Tailscale arrêté ⇒ bouton désactivé, l'explication est dans
  l'infobulle — couverture automatique : `test/web/boite.test.tsx`
- [ ] 12.b Connexion : un clic sur la pastille ⇒ « mesh · connexion… » puis « mesh · 0 à
  traiter » ; `swarph monitor status --json` dans un terminal dit `running: true` pour
  `morzu-mac` ; `~/swarph_state/morzu-mac/mesh-sidecar/inbox.log` existe — couverture
  automatique : `test/mesh-service.test.ts`, `test/mesh-routes.test.ts`, `e2e/mesh.spec.ts`
- [ ] 12.c Un DM arrive : depuis le VPS, `swarph mesh dm morzu-mac --kind question "…"`
  (ou peer-a depuis `mesh-gw`) ; en moins d'une minute, la pastille passe à « 1 à traiter »,
  la Boîte montre la section « Mesh · morzu-mac » avec le DM dans « À traiter » (émetteur,
  kind, horodatage, fil, contenu **en texte brut** dans le bloc « donnée d'un pair du
  mesh ») — couverture automatique : `e2e/mesh.spec.ts`, `test/web/boite.test.tsx`
- [ ] 12.d Notification : onglet caché, un DM `question` ou `unblock` déclenche une
  notification du navigateur ; un `fyi` n'en déclenche pas ; le clic mène à la Boîte —
  couverture automatique : `test/web/notifications.test.tsx`
- [ ] 12.e « Vu » retire le DM de la Boîte et décrémente la pastille ; il ne touche pas au
  ledger de swarph (le DM reste `unread` côté cell : `swarph mesh inbox --peek` le montre
  encore) — couverture automatique : `e2e/mesh.spec.ts`, `test/mesh-routes.test.ts`
- [ ] 12.f « Ouvrir la cell » : choix d'un sujet actif ⇒ un agent `swarph-cell` s'ouvre dans
  le terminal du sujet, c'est la session Claude de la cell (`swarph spawn … --no-starter
  --no-banner`), son cwd est le worktree du sujet ; un second « Ouvrir la cell » devient un
  lien vers ce terminal (409 côté daemon si on force) — couverture automatique :
  `test/pty-spawn.test.ts`, `e2e/mesh.spec.ts`
- [ ] 12.g Répondre : depuis la session de la cell, répondre au DM (`swarph mesh reply` ou
  la réponse que la session propose) ; le fil se complète côté émetteur ; les hooks
  `AID_HOOK` remontent les statuts fins de cette session comme pour tout `claude`
- [ ] 12.h Déconnexion : clic sur la pastille ⇒ « hors mesh depuis … » ; `monitor status`
  dit `running: false` ; Tailscale est toujours connecté (`manage: false`) ; `ssh vps`
  passe toujours — couverture automatique : `e2e/mesh.spec.ts`
- [ ] 12.i Reconnexion une heure plus tard : les DM envoyés entre-temps à `morzu-mac`
  arrivent (le monitor en mode `pull` les rattrape), sans doublon dans la Boîte
  (curseur par `id`) — couverture automatique : `test/mesh-service.test.ts` (ids déjà
  vus ignorés)
- [ ] 12.j Redémarrage du daemon (`aid stop` puis `aid`) pendant une connexion : au
  retour, la pastille retrouve « connecté » sans relancer le monitor (il tourne toujours,
  détaché), et la Boîte garde ses DM — couverture automatique :
  `test/mesh-service.test.ts` (init reprend un monitor vivant)
- [ ] 12.k Le token n'apparaît nulle part : ni dans `~/.aid/config.yaml`, ni dans
  `~/.aid/state.db`, ni dans l'environnement de la cell ouverte (`env | grep -i token` dans
  un shell du même sujet est vide) — couverture automatique : `test/pty-spawn.test.ts`
  (seuls `MESH_GATEWAY_URL` et `SWARPH_STATE` sont ajoutés)

## Ce que la recette a révélé

**Au 2026-10-20, la recette manuelle n'a pas été déroulée** : les prérequis 12.0 sont à faire par
Julien (swarph absent du Mac, Tailscale arrêté, pas de cell). Seule la couverture automatique a
tourné, sur les faux binaires.

Trouvé par `e2e/mesh.spec.ts` et corrigé (12.7) : après « Vu », la Boîte ne se mettait pas à
jour — la marque « vu » est une écriture locale sans événement (choix de 12.4), et l'interface
ne relit l'instantané que sur événement. La Boîte relit l'instantané après le POST. Reste en
review la question de fond posée en 12.4 : un événement `mesh.seen` rendrait la marque
rejouable et visible des autres onglets.

Constaté sur ce poste en lançant `npm run gate:e2e` (rien de propre au mesh, mais à savoir) :

- le port 4871 des e2e est écouté par l'app de bureau `AID.app` : `AID_E2E_PORT=4873` contourne
  (variable ajoutée à `e2e/global-setup.ts` en 12.7) ;
- `scripts/package-server.sh` exige Node 22 ; un shell où Node 24 passe devant (`mise` non
  activé) fait échouer `test/package-server.test.ts` avant Playwright : `mise exec node@22 --
  npm run gate:e2e` ;
- depuis une session lancée par A-I-D, les `AID_*` exportées (jeton de run limité au namespace
  `aid`) sont héritées par `aid mem put` dans `e2e/memoire.spec.ts` (« interdit : namespace … ») et
  par `test/pty-spawn.test.ts` : retirer toutes les `AID_*` de l'environnement avant le gate.

**Pas de reprise automatique.** Si Tailscale ou le monitor tombe, `refresh()` passe le mesh à
« déconnecté », arrête le suivi de `inbox.log` et le rafraîchissement périodique, et ne tente aucune
reconnexion : il faut cliquer à nouveau sur « Rejoindre ». C'est le comportement actuel, à
vérifier à la main en coupant Tailscale pendant une session connectée.
