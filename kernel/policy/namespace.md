# Taxonomie mémoire

La mémoire est partagée par toutes les instances, tous projets confondus. Sans
discipline de nommage, un projet pollue la recherche des autres.

## Deux niveaux

### Cyclique — préfixé par le projet

```
<namespace>/plan/<task>
<namespace>/dev-handoff/<task>
<namespace>/review/<task>
<namespace>/retro/<cycle>
```

`<namespace>` vient de `project.namespace` du manifeste. `<task>` est un slug
stable sur toute la durée du cycle — il fait le lien entre les quatre pages.

Ces pages se purgent une fois la rétro faite.

### Transverse — délibérément sans projet

```
lesson/<domaine>/<slug>
```

`<domaine>` est un domaine technique, pas un projet : `delta`, `supabase`,
`pyspark`, `typescript`, `orchestration`.

C'est ici que vit la connaissance collective. Un piège appris sur un projet
doit être trouvable depuis un autre. Aucun outil ne donne ça gratuitement —
l'index structurel est par projet par construction. Seule la réservation de
cet espace de nommage le rend possible.

**Le namespace est le premier segment du slug.** `lesson/…` vit donc dans un espace
qui n'appartient à aucun projet, par construction. Il n'y a rien à fédérer ni à
vérifier : une recherche portée sur un projet (`--scope <namespace>`) inclut toujours
`lesson/`, et une recherche `--scope all` traverse tout. Le cloisonnement, quand on le
veut, est une décision d'appel, visible dans le handoff, pas un état de l'outil.

## Règles d'écriture

**Une page = une affirmation durable.** Si le contenu est vrai seulement
pendant ce cycle, il va dans une page cyclique, pas dans `lesson/`.

**Une leçon est atomique.** Frontmatter YAML : `domaine`, `tags` (liste), `entites`
(liste : outils, services, dépôts concernés), `cycle` (le `<namespace>/<task>` d'où
elle vient). Corps : **une** affirmation, quinze lignes au plus, l'exemple minimal qui
la prouve. Deux affirmations, deux pages. C'est ce qui décide du coût d'une phase
plan : elle charge des leçons, pas des chapitres.

```markdown
---
domaine: sqlite
tags: [wal, concurrence]
entites: [better-sqlite3]
cycle: <namespace>/<task>
---

# Un seul processus écrit dans une base SQLite

Les lecteurs ne bloquent jamais en WAL ; deux écrivains dans deux processus
se disputent le verrou. Faire passer toutes les écritures par un seul
processus, et garder les transactions courtes.
```

**Rien de dérivable du code.** Voir `policy/routing.md`. Une page qui décrit
la structure du code est une page à supprimer.

**Promotion vers `lesson/` uniquement en rétro.** Aucune autre phase n'écrit
dans l'espace transverse. Ça évite l'accumulation de leçons non validées par
l'usage.

## Amorçage

Ne pas pré-remplir rétroactivement. Une mémoire pré-écrite est de la
documentation morte que personne n'a validée en usage. L'espace se remplit
aux frontières de phase, ou il ne mérite pas d'être rempli.
