# 12 — Mesh swarph : ce qui reste à faire, par acteur

Le code des points 12.1 à 12.7 est livré sur `feat/mesh-swarph` (PR ouverte le 2026-10-21).
Tout tourne sur les faux binaires ; **rien n'a encore été exercé contre le vrai mesh.** Les
actions ci-dessous conditionnent la recette manuelle (`docs/recette-v0.4-mesh.md`) et la
fusion. L'ordre compte : peer-a d'abord (identité), puis le Mac, puis le VPS, puis la recette.

## peer-a (hôte `gateway`)

- [ ] **Enregistrer le peer `cell-aid`** sur le gateway : soit transmettre à Julien un
  `MESH_GATEWAY_TOKEN` partagé pour qu'il fasse `swarph onboard cell-aid` lui-même, soit
  créer le peer de son côté. Dans les deux cas, le token de peer finit dans
  `~/.config/swarph/cell-aid.peer_token` sur le Mac et nulle part ailleurs (A-I-D ne le lit
  jamais).
- [ ] **Ratifier** le peer (`swarph ratify cell-aid`) : sans ratification, `cell-aid` lit
  déjà son inbox et envoie des DM, mais ne peut pas réclamer de tâche (`task_claim`).
- [ ] **Recevoir la réponse au DM 73544** (2026-10-16, « A-I-D lira-t-il le board comme
  `swairm inbox` ? un JSON versionné convient-il ? ») : le contrat retenu est que A-I-D ne
  parle jamais au gateway et lit `inbox.log` localement (D35) ; le board viendra dans un
  chantier à part, probablement via `swarph board … --json`. C'est Julien qui répond (voir
  plus bas), peer-a qui confirme que ce contrat lui va.
- [ ] Optionnel, à discuter : une capacité `presence` du mesh. En v1, se connecter n'annonce
  rien (D41) ; un pair qui écrit à `cell-aid` hors connexion n'a aucun signal, les DM
  attendent au gateway.

## Julien — sur le Mac

- [ ] **Installer swarph** : `uv tool install --python 3.12 swarph-cli`, puis
  `swarph --version` (≥ 0.72 ; le VPS est en 0.72.20, le clone en 0.72.25).
- [ ] **Démarrer Tailscale** (Tailscale.app) et vérifier le gateway :
  `curl -s -m 5 http://gateway.example.ts.net:8788/health` → `200`.
- [ ] **Onboarding** : avec le token partagé reçu de peer-a,
  `MESH_GATEWAY_URL=http://gateway.example.ts.net:8788 MESH_GATEWAY_TOKEN=… swarph onboard cell-aid` ;
  vérifier que `~/.config/swarph/cell-aid.peer_token` existe. Ne jamais copier le token de
  `cell-gestion` : deux lecteurs sous la même identité se volent l'état de lecture (D34).
- [ ] **Créer la cell** : `swarph init cell-aid --provider claude --role cell-aid` depuis un
  dossier de travail (pas un worktree A-I-D) ; `swarph spawn cell-aid --dry-run` affiche la
  commande `claude` attendue ; `~/.config/swarph/cells/cell-aid.yaml` existe.
- [ ] **Configurer A-I-D** dans `~/.aid/config.yaml` :

  ```yaml
  mesh:
    cell: cell-aid
    gateway: http://gateway.example.ts.net:8788
  ```

  Laisser `tailscale.manage` à `false` : `tailscale down` couperait `ssh vps` (D37).

- [ ] **`aid doctor`** : les cinq lignes mesh vertes (swarph trouvé, cell lisible, token
  présent, gateway configuré, Tailscale connecté). Le daemon tourne depuis la release
  (`~/.aid/server/current`) : la section `mesh` n'est lue qu'une fois cette branche fusionnée
  et une release produite — d'ici là, tester depuis le worktree (`aid` lancé depuis `dist/`).
- [ ] **Répondre au DM 73544 de `gateway`** (depuis la cell du VPS ou, après recette,
  depuis `cell-aid`) avec le contrat D35 ci-dessus.

## Julien — sur le VPS (`ssh vps`, hors A-I-D)

- [ ] **Relancer le monitor de `cell-gestion`**, mort depuis le 16/10 (16 DM de `gateway` non
  livrés) :
  `MESH_GATEWAY_URL=http://gateway.example.ts.net:8788 SWARPH_SELF=cell-gestion ~/.local/bin/swarph monitor start --deliver pull`,
  puis `~/.local/bin/swarph monitor status --brief`. Sans lui, `cell-gestion` ne peut pas
  répondre à `cell-aid` pendant la recette.
- [ ] Pendant la recette : envoyer un DM à `cell-aid`
  (`swarph mesh send cell-aid --kind question --content "…" --as cell-gestion`) pour les lignes 12.c et 12.i.

## Julien — recette et fusion

- [ ] Dérouler `docs/recette-v0.4-mesh.md`, lignes 12.a à 12.k, dans le vrai navigateur ;
  noter ce qui casse dans sa section « Ce que la recette a révélé ».
- [ ] Review des sept commits (`e4a0418` → `e52a99b`) et des choix « pris dans la marge »
  listés dans le handoff `aid/dev-handoff/mesh-swarph`. Les deux qui méritent un arbitrage :
  - la marque « vu » est une écriture locale sans événement (ne survit pas à un rejeu du
    journal, invisible des autres onglets) — alternative : un type `mesh.seen` ;
  - le daemon e2e a désormais une section `mesh` pour toutes les épreuves (un seul
    `global-setup`), et `AID_E2E_PORT` a été ajouté parce qu'`AID.app` écoute 4871 sur ce
    poste.
- [ ] Fusionner, produire la release, relancer le daemon depuis `~/.aid/server/current`.
- [ ] Supprimer `feat/mesh-swarph-sauvegarde-2026-10-20` (ancienne tête avant le rebase sur
  v0.2.2) une fois satisfait.

## Pour relancer les gates sur ce poste

Trois pièges, aucun propre au mesh :

```bash
# toutes les AID_* d'une session lancée par A-I-D, Node 22 (mise), port 4871 pris par AID.app
env $(env | grep -o '^AID_[A-Z_]*' | sed 's/^/-u /') mise exec node@22 -- npm run gate < /dev/null
AID_E2E_PORT=4873 env $(env | grep -o '^AID_[A-Z_]*' | sed 's/^/-u /') mise exec node@22 -- npm run gate:e2e < /dev/null
```
