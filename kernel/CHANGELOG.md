# Changelog (noyau)

Sous-séquence de l'historique d'aidboard, filtrée aux changements qui
touchent réellement `kernel/` (adapters, policy, roles, gabarit,
`commands/sync.md`, défauts). Une version purement daemon d'aidboard n'y
ajoute rien. Format : chaque version majeure du noyau décrit sa
**migration**, que `/sync` applique avant de rendre le bloc ; les mineures
et patchs n'en ont pas, sauf mention contraire.

## [Fusion — agent-kernel → aidboard, 2026-10-17]

Toute version `kernel.version` antérieure à cette entrée (par exemple
`0.9.0`, `0.7.1`, ou toute autre version numérotée par l'ancien dépôt
`agent-kernel`) est une version **pré-fusion** : ne la compare jamais
numériquement à la version d'aidboard qui la remplace. Le compteur de
version du noyau repart de celui d'aidboard (`aid --version`), qui peut être
numériquement plus petit sans que le contenu du noyau soit plus ancien.

### Pourquoi

Chantier 09 (`docs/chantiers/09-fusion-agent-kernel.md`) : `agent-kernel`
cesse d'exister comme dépôt séparé à cloner et maintenir ; aidboard embarque
et distribue `kernel/` directement dans son package npm. `kernel.version`
se confond désormais avec la version d'aidboard (DS2) — le noyau n'a plus de
numérotation indépendante.

### Ce qu'il faut faire, sur chaque poste et chaque projet déjà rattaché

1. Mettre à jour le paquet `aid` (npm), puis lancer `aid kernel install` —
   ça remplace l'ancien `git pull` dans `~/.agent-kernel` (plus de clone
   séparé à maintenir).
2. `/sync` sur le projet : détecte le pin pré-fusion, affiche cette entrée,
   et réécrit `kernel.version` à la version d'aidboard installée après
   validation. Aucune autre migration de contenu n'est nécessaire : la
   politique elle-même (routage, phases, orchestration, rôles) ne change pas
   de sens, seulement d'adresse et de mécanique de distribution.

### Changé

- Plus de fichier `VERSION` séparé pour le noyau : `aid --version` fait foi.
- `commands/sync.md` §2 lit `~/.agent-kernel/CHANGELOG.md` (ce fichier) à la
  place du `CHANGELOG.md` racine d'`agent-kernel`.
