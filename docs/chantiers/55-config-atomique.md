# Chantier 55 : config.yaml écrit d'un coup

| Champ | Valeur |
|---|---|
| État | **Révision 0, 15 novembre 2026.** Proposé par le lab en relisant le 33.3 (DM 98355, point h). Julien a dit oui le 15 novembre. |
| Emplacement final | `docs/chantiers/55-config-atomique.md` sur `main` |
| Base | `main`. |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI code sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Le lab relit le code. Julien donne son oui pour le merge, CI verte. |

## 1. Le constat

Quatre fonctions de `src/daemon/config.ts` réécrivent `config.yaml` : `ecrireModeHostActif`, `ecrireModeHostPush`, `ecrireModeHostCode` et `ecrireModeHostPda`. Chacune relit le fichier, le modifie, valide le résultat avec `parseConfig`, puis l'écrit **sur place** avec `writeFileSync`. `writeDefaultConfigIfAbsent` crée le fichier de la même façon.

Une coupure pendant l'écriture (courant, plantage, disque plein) laisse un fichier vide ou tronqué. Au démarrage suivant, `loadConfig` le refuse et le daemon ne démarre plus. Le chantier 33 ajoute un cinquième écrivain, `modifierMesh`, qui a le même défaut.

## 2. Décisions

### D337. Une seule écriture, par fichier temporaire et renommage

- Une fonction `ecrireConfig(p, texte)` dans `src/daemon/config.ts`, utilisée par les quatre écrivains et par `writeDefaultConfigIfAbsent`. Aucun autre code n'écrit `config.yaml`.
- **Le chemin réel.** Si `config.yaml` est un lien symbolique, la cible du lien est remplacée et le lien reste en place (`realpathSync`). Un lien cassé est refusé par une `ConfigError`, sans rien écrire.
- **Le fichier temporaire** est créé dans le dossier de la cible, sous un nom qui commence par `.config.yaml.` et finit par `.tmp`, en création exclusive (`wx`). Ses droits sont ceux du fichier existant ; pour un fichier neuf, 0600.
- **L'ordre** : écrire tout le texte, `fsync` du fichier, le fermer, `renameSync` vers la cible, puis `fsync` du dossier. Le `fsync` du dossier est fait au mieux : un échec (Windows) est ignoré.
- **En cas d'erreur** avant le renommage, le fichier temporaire est supprimé et l'erreur remonte. L'ancien `config.yaml` reste intact.
- `writeDefaultConfigIfAbsent` garde son contrôle d'existence, puis passe par `ecrireConfig`.
- La validation par `parseConfig` avant l'écriture ne change pas.
- Hors périmètre : le propriétaire du fichier (un daemon sans privilèges ne peut pas le changer, et le fichier est déjà à lui) ; le nettoyage d'un temporaire laissé par une coupure entre sa création et son renommage, qui ne gêne pas le démarrage.

## 3. Points

### 55.1 L'écriture atomique (D337)

- `src/daemon/config.ts` : `ecrireConfig`, et les cinq appels.
- **Tests** (`test/config-atomique.test.ts`) :
  - une écriture qui échoue au milieu (fonction d'écriture injectée, ou fichier temporaire impossible à créer) laisse l'ancien fichier octet pour octet, et aucun fichier `.config.yaml.*.tmp` ;
  - les droits sont gardés : un fichier en 0640 reste en 0640, et un fichier neuf est en 0600 ;
  - un `config.yaml` qui est un lien symbolique reste un lien, et sa cible porte le nouveau texte ; un lien cassé est refusé sans rien écrire ;
  - les quatre écrivains et `writeDefaultConfigIfAbsent` passent par `ecrireConfig` (par leur effet : contenu, droits et absence de temporaire) ;
  - un texte refusé par `parseConfig` n'écrit toujours rien.
- Le gate entier, et `gate:e2e` entier sous Node 22 avec `CI=1`.

## 4. Après le merge

Le chantier 33 fait passer `modifierMesh` par `ecrireConfig` (un point de 33, après le merge de 55 dans sa branche).

## 5. Fini quand

- Le point 55.1 est commité, le gate et `gate:e2e` sont verts sur le VPS, et la CI de la PR est verte.
- Le lab a relu le code.
- Julien a donné son oui pour le merge.
