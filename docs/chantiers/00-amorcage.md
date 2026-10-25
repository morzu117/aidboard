# 00 — Amorçage du dépôt

## Pourquoi

`a-i-d/` ne contient qu'un brief et des maquettes : pas de dépôt git, pas de toolchain, pas
de gate. Les chantiers suivants partent du principe qu'un `npm run gate` existe, que le
kernel a rendu son bloc et que les maquettes sont rangées là où l'UI les lira.

## État actuel

```
a-i-d/
  brief.md
  design/README_1.md
  design/aid-1-1-accueil_1.html
  design/aid-1-2-boite-de-reception_1.html
  design/aid-1-3-sujet_1.html
  docs/chantiers/          (ces plans)
```

`design/README_1.md:7-9` désigne les fichiers sous `html/aid-1-1-accueil.html`… : les noms
ne correspondent pas (suffixe `_1`, pas de dossier `html/`).

## Cible

Un dépôt git avec la structure finale, une toolchain qui compile un « hello » daemon et une
page vide, un gate vert, les maquettes rangées, le bloc agent-kernel rendu.

Hors périmètre : toute logique métier.

## Décisions prises

- Arborescence (fixe, les chantiers suivants s'y réfèrent) :

```
package.json
mise.toml                      node = "22"
tsconfig.json                  base commune, strict
tsconfig.daemon.json           src/daemon, src/cli, src/shared → dist/
web/                           racine Vite (index.html, src/)
web/tsconfig.json
src/shared/                    types partagés daemon ↔ UI (aucune dépendance Node)
src/daemon/                    serveur
src/cli/aid.ts                 point d'entrée du binaire
scripts/git/                   scripts bash des actions git
migrations/                    *.sql
test/                          vitest (unit + intégration)
test/fixtures/
e2e/                           playwright
design/maquettes/              références HTML + README
docs/chantiers/
```

- Scripts npm (noms fixes) :

| Script | Commande |
| --- | --- |
| `typecheck` | `tsc -p tsconfig.daemon.json --noEmit && tsc -p web/tsconfig.json --noEmit` |
| `lint` | `eslint . && prettier --check .` |
| `test` | `vitest run` |
| `build` | `tsup && vite build web` |
| `e2e` | `playwright test` |
| `gate` | `npm run typecheck && npm run lint && npm run test && npm run build` |
| `gate:e2e` | `npm run build && npm run e2e` |
| `dev:web` | `vite web` (proxy `/api` et `/ws` vers `http://127.0.0.1:4870`) |
| `dev:daemon` | `node --enable-source-maps dist/cli/aid.js daemon --foreground` après `tsup` — **pas de watch** |

- Le daemon n'a **pas** de rechargement à chaud : chaque redémarrage tue les PTY de test.
- `engines.node`: `">=22.12 <25"` (D4).
- `"type": "module"` ; ESM partout.

## Points

### 00.1 — Dépôt git et maquettes rangées

- `git init -b main`, `.gitignore` : `node_modules/`, `dist/`, `.codegraph/`, `coverage/`,
  `playwright-report/`, `test-results/`, `.DS_Store`.
- `git mv` impossible (rien n'est suivi) : déplacer à la main
  `design/aid-1-1-accueil_1.html` → `design/maquettes/aid-1-1-accueil.html`, idem 1-2 et 1-3,
  `design/README_1.md` → `design/maquettes/README.md`.
- Dans `design/maquettes/README.md`, seules les lignes 7 à 9 changent : `html/aid-…` →
  `aid-…` (les fichiers sont à côté du README).
- Supprimer `design/.DS_Store` et `.DS_Store` (non suivis).
- Commit : `chore: dépôt initial, brief et maquettes`.

Vérif : `git status` propre, `ls design/maquettes` liste 4 fichiers.

### 00.2 — Toolchain et gate vides

- `package.json` : nom `aidboard` (D1), `private: true` tant que 05 n'est pas livré,
  `bin: { "aidboard": "dist/cli/aid.js", "aid": "dist/cli/aid.js" }`, `engines`, scripts
  ci-dessus.
- Dépendances de dev : `typescript`, `tsup`, `vite`, `@vitejs/plugin-react`, `vitest`,
  `@playwright/test`, `eslint`, `typescript-eslint`, `eslint-plugin-react`,
  `eslint-plugin-react-hooks`, `prettier`, `@types/node`, `@types/react`,
  `@types/react-dom`.
- Dépendances : `react`, `react-dom` (les autres arrivent avec le point qui les utilise).
- `tsup.config.ts` : entrées `src/cli/aid.ts`, format `esm`, `target: node22`,
  `platform: node`, `external` : `node-pty`, `better-sqlite3` (natifs, jamais embarqués).
- `src/cli/aid.ts` : `#!/usr/bin/env node`, affiche la version de `package.json`.
- `web/index.html` + `web/src/main.tsx` : rend `<p>A-I-D</p>`.
- `eslint.config.js` : `react/no-danger: "error"`, `no-restricted-syntax` interdisant
  `exec`/`execSync` de `node:child_process` (seuls `spawn`/`execFile` autorisés).
- `test/smoke.test.ts` : la version du CLI égale celle de `package.json`.
- `mise.toml` : `[tools] node = "22"`.

Vérif : `npm run gate` vert ; `node dist/cli/aid.js` affiche la version.

### 00.3 — Proxy de dev et squelette e2e

- `web/vite.config.ts` : `server.host: '127.0.0.1'`, `server.proxy` pour `/api`, `/auth` et
  `/ws` (`ws: true`) vers `http://127.0.0.1:4870` avec `changeOrigin: true` (sinon le
  daemon reçoit `Host: 127.0.0.1:5173` et répond 421) ; `build.outDir: "../dist/web"`,
  `emptyOutDir: true`.
- `playwright.config.ts` : `webServer` absent pour l'instant (ajouté en 05.3) ; un test
  `e2e/vide.spec.ts` marqué `test.skip` qui documente le lancement prévu.

Vérif : `npm run gate` vert, `npm run e2e` passe (test sauté).

### 00.4 — Rattachement à agent-kernel

**Pas exécutable par l'agent de dev** : `/sync` est une commande interactive que Julien
valide. L'exécutant s'arrête ici et le signale.

Attendu après `/sync` : `agent.yml` (namespace `aid`, `kernel.version` épinglée à la version
du kernel, `0.7.1` au moment de la rédaction), bloc `<!-- agentkit:start … -->` dans
`CLAUDE.md` et `AGENTS.md`, gates détectés : `gate` et `gate:e2e`.

Le dépôt distant `morzu117/a-i-d` (D11) se crée à ce moment, si Julien l'accepte.

> Depuis : le dépôt public est `morzu117/aidboard` ; `a-i-d` n'a jamais été créé sous ce nom.

## Pièges

- `prettier --check .` sur les maquettes HTML : elles ne doivent **jamais** être reformatées
  (référence d'implémentation lue par programme). `.prettierignore` : `design/`, `brief.md`,
  `dist/`.
- tsup qui embarque `node-pty` ou `better-sqlite3` : le binaire `.node` ne suit pas, erreur à
  l'exécution seulement. Ils restent en `external`.
- `vite build web` avec `outDir` relatif : relatif à la racine Vite (`web/`), d'où `../dist/web`.

## Fini quand

- `npm run gate` vert sous Node 22 et sous Node 24.
- Maquettes dans `design/maquettes/`, README cohérent.
- `/sync` passé par Julien, `agent.yml` commité.
