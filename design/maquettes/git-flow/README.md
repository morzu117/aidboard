# A-I-D · git flow · références d’implémentation (écrans 2.1 à 2.9)

Neuf fichiers HTML statiques, destinés à être lus par un programme. Ils suivent les mêmes règles que l’export 1.x : un fichier par écran, 16 cadres (4 états × 4 tailles) et 1 cadre de survol, soit 153 cadres au total. Tout le parcours suit un même sujet : l’issue aid #12, branche `feat/12-spool-replay`.

| Fichier | Écran | État du sujet |
|---|---|---|
| `html/aid-2-1-nouveau-sujet.html` | 2.1 Nouveau sujet : formulaire et aperçu des commandes | draft |
| `html/aid-2-2-preparation.html` | 2.2 Préparation du worktree (topic.create en cours) | draft |
| `html/aid-2-3-synchronisation.html` | 2.3 Synchronisation (en retard sur la base) et critères avant la PR | active |
| `html/aid-2-4-conflit.html` | 2.4 Sync arrêtée sur un conflit (code de sortie 2) | active |
| `html/aid-2-5-ouvrir-la-pr.html` | 2.5 Ouvrir la PR : commit en attente, titre, description, commandes | active |
| `html/aid-2-6-revue.html` | 2.6 Revue : vérifications, commentaire de grokbot, fusion bloquée | review |
| `html/aid-2-7-fusion.html` | 2.7 Fenêtre de fusion : stratégie, message, options | review |
| `html/aid-2-8-nettoyage.html` | 2.8 Fenêtre de nettoyage : refus, stash ou suppression forcée | merged |
| `html/aid-2-9-archive.html` | 2.9 Sujet archivé : chronologie | archived |

## Conventions (identiques à l’export 1.x)

- **Cadre** : la racine porte `data-screen` (2.1 à 2.9), `data-state` (default, empty, loading, error, hover) et `data-viewport` (phone 390, tablet 834, desktop 1440, wide 1920). La hauteur suit le contenu. Le cadre `hover` fait 480 px et porte `data-viewport="desktop"`.
- **`data-node`** : `écran.zone.élément[.champ]`, l’écran s’écrit avec un tiret (`2-4.conflit.fichier-1.resolu`). Les éléments répétés sont indicés. Chaque `data-node` est unique dans son cadre et identique sur les quatre tailles d’un même état : ce qui n’a pas la place est masqué en CSS, jamais retiré.
- **`data-bind`** : nom du champ fourni par le daemon. **`data-action`** : intention déclenchée par un élément interactif. Les identifiants `topic.create`, `topic.sync`, `topic.pr`, `topic.merge` et `topic.cleanup` sont ceux du registre d’actions de la spec.
- **Bouton désactivé** : l’attribut HTML `disabled` est la règle à implémenter. Par exemple, « Continuer le rebase » reste désactivé tant qu’un fichier est en conflit, et « Fusionner… » tant qu’une vérification tourne.
- **`data-layer="overlay"`** : l’infobulle des cadres hover (en position absolue), et la fenêtre `role="dialog"` des écrans 2.7 et 2.8. Pour ces deux écrans, le cadre montre la fenêtre seule sur son fond. À l’implémentation, elle se superpose à l’écran du sujet.
- **Styles** : aucun attribut `style`, toutes les couleurs sont dans `:root`, Inter est la seule police, la mise en page est en flex ou grid, et les tailles se distinguent par `[data-viewport="…"]`. HTML statique, sans script.

## États empty et error, écran par écran

| Écran | empty | Second cas d’erreur (en plus du daemon injoignable) |
|---|---|---|
| 2.1 | aucun repo enregistré | la branche existe déjà |
| 2.2 | worktree.setup vide | npm ci échoue (code 1) |
| 2.3 | déjà à jour, rien à synchroniser | git fetch refusé (authentification) |
| 2.4 | tous les conflits résolus | rebase introuvable (terminé hors d’A-I-D) |
| 2.5 | aucune modification depuis la base | gh non authentifié |
| 2.6 | ni vérification ni revue | GitHub ne répond pas |
| 2.7 | PR déjà fusionnée sur GitHub | fusion refusée par la protection de branche |
| 2.8 | worktree propre | dossier verrouillé par un process (Windows) |
| 2.9 | historique effacé (rétention) | stash introuvable |

## Vocabulaire `data-action`

agent.arreter-tous, agent.lancer, archive.oublier-stash, commentaire.repondre, commentaire.transmettre, commit.creer, commit.saisir, config.ouvrir, conflit.confier, conflit.marquer, creation.agent, creation.base, creation.issue, creation.slug-saisir, creation.titre-saisir, creation.type, creation.workspace, daemon.reconnecter, editeur.ouvrir, fusion.fermer, fusion.message-saisir, fusion.nettoyer-apres, fusion.strategie, fusion.supprimer-distante, nav.accueil, nav.boite, nav.consignes, nav.reglages, nettoyage.choix, nettoyage.confirmer, nettoyage.fermer, palette.ouvrir, pr.brouillon, pr.demander-revue, pr.description-modifier, pr.ouvrir, pr.preparer, pr.rafraichir, pr.titre-saisir, sujet.creer, sujet.rafraichir, sync.strategie, topic.cleanup, topic.cleanup-ouvrir, topic.create, topic.create-existante, topic.merge, topic.merge-ouvrir, topic.pr, topic.retour-active, topic.setup, topic.setup-ignorer, topic.sync, topic.sync-annuler, topic.sync-continuer, workspace.ajouter

## Vocabulaire `data-bind`

action.commande, action.id, action.libelle, action.statut, agent.type, apercu.commande, apercu.source, base.resume, commentaire.auteur, commentaire.contexte, commentaire.texte, commit.auteur, commit.hash, commit.message, commit.origine, conflit.commit, conflit.consigne, conflit.resolus, conflit.total, consigne.source, consigne.texte, cycle.statut, daemon.etat, erreur.cause, evenement.heure, evenement.source, evenement.texte, evenement.type, fichier.ajouts, fichier.chemin, fichier.etat, fichier.suppressions, fichier.zones, fusion.message, fusion.regle, fusion.source, fusion.strategie, issue.label, issue.numero, issue.titre, journal.ligne, pr.critere, pr.description, pr.resume, pr.titre, preparation.commande, preparation.cwd, preparation.sortie, preparation.source, preparation.statut, relais.etat, resume.en_attente, run.agents_pauses, stash.portee, stash.recherche, stash.restauration, sujet.base, sujet.branche, sujet.etat, sujet.longueur_chemin, sujet.pr, sujet.regle_slug, sujet.retard_base, sujet.slug, sujet.titre, sujet.type, sujet.worktree, verification.duree_moyenne, verification.etape, verification.etat, verification.job, verification.nom, workspace.nom

## Cadres produits (153)

| # | Écran | État | Taille | Largeur |
|---|---|---|---|---|
| 1 | 2.1 Nouveau sujet | default | phone | 390 px |
| 2 | 2.1 Nouveau sujet | default | tablet | 834 px |
| 3 | 2.1 Nouveau sujet | default | desktop | 1440 px |
| 4 | 2.1 Nouveau sujet | default | wide | 1920 px |
| 5 | 2.1 Nouveau sujet | empty | phone | 390 px |
| 6 | 2.1 Nouveau sujet | empty | tablet | 834 px |
| 7 | 2.1 Nouveau sujet | empty | desktop | 1440 px |
| 8 | 2.1 Nouveau sujet | empty | wide | 1920 px |
| 9 | 2.1 Nouveau sujet | loading | phone | 390 px |
| 10 | 2.1 Nouveau sujet | loading | tablet | 834 px |
| 11 | 2.1 Nouveau sujet | loading | desktop | 1440 px |
| 12 | 2.1 Nouveau sujet | loading | wide | 1920 px |
| 13 | 2.1 Nouveau sujet | error | phone | 390 px |
| 14 | 2.1 Nouveau sujet | error | tablet | 834 px |
| 15 | 2.1 Nouveau sujet | error | desktop | 1440 px |
| 16 | 2.1 Nouveau sujet | error | wide | 1920 px |
| 17 | 2.1 Nouveau sujet | hover | desktop (cadre réduit) | 480 px |
| 18 | 2.2 Préparation du worktree | default | phone | 390 px |
| 19 | 2.2 Préparation du worktree | default | tablet | 834 px |
| 20 | 2.2 Préparation du worktree | default | desktop | 1440 px |
| 21 | 2.2 Préparation du worktree | default | wide | 1920 px |
| 22 | 2.2 Préparation du worktree | empty | phone | 390 px |
| 23 | 2.2 Préparation du worktree | empty | tablet | 834 px |
| 24 | 2.2 Préparation du worktree | empty | desktop | 1440 px |
| 25 | 2.2 Préparation du worktree | empty | wide | 1920 px |
| 26 | 2.2 Préparation du worktree | loading | phone | 390 px |
| 27 | 2.2 Préparation du worktree | loading | tablet | 834 px |
| 28 | 2.2 Préparation du worktree | loading | desktop | 1440 px |
| 29 | 2.2 Préparation du worktree | loading | wide | 1920 px |
| 30 | 2.2 Préparation du worktree | error | phone | 390 px |
| 31 | 2.2 Préparation du worktree | error | tablet | 834 px |
| 32 | 2.2 Préparation du worktree | error | desktop | 1440 px |
| 33 | 2.2 Préparation du worktree | error | wide | 1920 px |
| 34 | 2.2 Préparation du worktree | hover | desktop (cadre réduit) | 480 px |
| 35 | 2.3 Synchronisation | default | phone | 390 px |
| 36 | 2.3 Synchronisation | default | tablet | 834 px |
| 37 | 2.3 Synchronisation | default | desktop | 1440 px |
| 38 | 2.3 Synchronisation | default | wide | 1920 px |
| 39 | 2.3 Synchronisation | empty | phone | 390 px |
| 40 | 2.3 Synchronisation | empty | tablet | 834 px |
| 41 | 2.3 Synchronisation | empty | desktop | 1440 px |
| 42 | 2.3 Synchronisation | empty | wide | 1920 px |
| 43 | 2.3 Synchronisation | loading | phone | 390 px |
| 44 | 2.3 Synchronisation | loading | tablet | 834 px |
| 45 | 2.3 Synchronisation | loading | desktop | 1440 px |
| 46 | 2.3 Synchronisation | loading | wide | 1920 px |
| 47 | 2.3 Synchronisation | error | phone | 390 px |
| 48 | 2.3 Synchronisation | error | tablet | 834 px |
| 49 | 2.3 Synchronisation | error | desktop | 1440 px |
| 50 | 2.3 Synchronisation | error | wide | 1920 px |
| 51 | 2.3 Synchronisation | hover | desktop (cadre réduit) | 480 px |
| 52 | 2.4 Conflit de sync | default | phone | 390 px |
| 53 | 2.4 Conflit de sync | default | tablet | 834 px |
| 54 | 2.4 Conflit de sync | default | desktop | 1440 px |
| 55 | 2.4 Conflit de sync | default | wide | 1920 px |
| 56 | 2.4 Conflit de sync | empty | phone | 390 px |
| 57 | 2.4 Conflit de sync | empty | tablet | 834 px |
| 58 | 2.4 Conflit de sync | empty | desktop | 1440 px |
| 59 | 2.4 Conflit de sync | empty | wide | 1920 px |
| 60 | 2.4 Conflit de sync | loading | phone | 390 px |
| 61 | 2.4 Conflit de sync | loading | tablet | 834 px |
| 62 | 2.4 Conflit de sync | loading | desktop | 1440 px |
| 63 | 2.4 Conflit de sync | loading | wide | 1920 px |
| 64 | 2.4 Conflit de sync | error | phone | 390 px |
| 65 | 2.4 Conflit de sync | error | tablet | 834 px |
| 66 | 2.4 Conflit de sync | error | desktop | 1440 px |
| 67 | 2.4 Conflit de sync | error | wide | 1920 px |
| 68 | 2.4 Conflit de sync | hover | desktop (cadre réduit) | 480 px |
| 69 | 2.5 Ouvrir la PR | default | phone | 390 px |
| 70 | 2.5 Ouvrir la PR | default | tablet | 834 px |
| 71 | 2.5 Ouvrir la PR | default | desktop | 1440 px |
| 72 | 2.5 Ouvrir la PR | default | wide | 1920 px |
| 73 | 2.5 Ouvrir la PR | empty | phone | 390 px |
| 74 | 2.5 Ouvrir la PR | empty | tablet | 834 px |
| 75 | 2.5 Ouvrir la PR | empty | desktop | 1440 px |
| 76 | 2.5 Ouvrir la PR | empty | wide | 1920 px |
| 77 | 2.5 Ouvrir la PR | loading | phone | 390 px |
| 78 | 2.5 Ouvrir la PR | loading | tablet | 834 px |
| 79 | 2.5 Ouvrir la PR | loading | desktop | 1440 px |
| 80 | 2.5 Ouvrir la PR | loading | wide | 1920 px |
| 81 | 2.5 Ouvrir la PR | error | phone | 390 px |
| 82 | 2.5 Ouvrir la PR | error | tablet | 834 px |
| 83 | 2.5 Ouvrir la PR | error | desktop | 1440 px |
| 84 | 2.5 Ouvrir la PR | error | wide | 1920 px |
| 85 | 2.5 Ouvrir la PR | hover | desktop (cadre réduit) | 480 px |
| 86 | 2.6 Revue de la PR | default | phone | 390 px |
| 87 | 2.6 Revue de la PR | default | tablet | 834 px |
| 88 | 2.6 Revue de la PR | default | desktop | 1440 px |
| 89 | 2.6 Revue de la PR | default | wide | 1920 px |
| 90 | 2.6 Revue de la PR | empty | phone | 390 px |
| 91 | 2.6 Revue de la PR | empty | tablet | 834 px |
| 92 | 2.6 Revue de la PR | empty | desktop | 1440 px |
| 93 | 2.6 Revue de la PR | empty | wide | 1920 px |
| 94 | 2.6 Revue de la PR | loading | phone | 390 px |
| 95 | 2.6 Revue de la PR | loading | tablet | 834 px |
| 96 | 2.6 Revue de la PR | loading | desktop | 1440 px |
| 97 | 2.6 Revue de la PR | loading | wide | 1920 px |
| 98 | 2.6 Revue de la PR | error | phone | 390 px |
| 99 | 2.6 Revue de la PR | error | tablet | 834 px |
| 100 | 2.6 Revue de la PR | error | desktop | 1440 px |
| 101 | 2.6 Revue de la PR | error | wide | 1920 px |
| 102 | 2.6 Revue de la PR | hover | desktop (cadre réduit) | 480 px |
| 103 | 2.7 Fusion (fenêtre) | default | phone | 390 px |
| 104 | 2.7 Fusion (fenêtre) | default | tablet | 834 px |
| 105 | 2.7 Fusion (fenêtre) | default | desktop | 1440 px |
| 106 | 2.7 Fusion (fenêtre) | default | wide | 1920 px |
| 107 | 2.7 Fusion (fenêtre) | empty | phone | 390 px |
| 108 | 2.7 Fusion (fenêtre) | empty | tablet | 834 px |
| 109 | 2.7 Fusion (fenêtre) | empty | desktop | 1440 px |
| 110 | 2.7 Fusion (fenêtre) | empty | wide | 1920 px |
| 111 | 2.7 Fusion (fenêtre) | loading | phone | 390 px |
| 112 | 2.7 Fusion (fenêtre) | loading | tablet | 834 px |
| 113 | 2.7 Fusion (fenêtre) | loading | desktop | 1440 px |
| 114 | 2.7 Fusion (fenêtre) | loading | wide | 1920 px |
| 115 | 2.7 Fusion (fenêtre) | error | phone | 390 px |
| 116 | 2.7 Fusion (fenêtre) | error | tablet | 834 px |
| 117 | 2.7 Fusion (fenêtre) | error | desktop | 1440 px |
| 118 | 2.7 Fusion (fenêtre) | error | wide | 1920 px |
| 119 | 2.7 Fusion (fenêtre) | hover | desktop (cadre réduit) | 480 px |
| 120 | 2.8 Nettoyage (fenêtre) | default | phone | 390 px |
| 121 | 2.8 Nettoyage (fenêtre) | default | tablet | 834 px |
| 122 | 2.8 Nettoyage (fenêtre) | default | desktop | 1440 px |
| 123 | 2.8 Nettoyage (fenêtre) | default | wide | 1920 px |
| 124 | 2.8 Nettoyage (fenêtre) | empty | phone | 390 px |
| 125 | 2.8 Nettoyage (fenêtre) | empty | tablet | 834 px |
| 126 | 2.8 Nettoyage (fenêtre) | empty | desktop | 1440 px |
| 127 | 2.8 Nettoyage (fenêtre) | empty | wide | 1920 px |
| 128 | 2.8 Nettoyage (fenêtre) | loading | phone | 390 px |
| 129 | 2.8 Nettoyage (fenêtre) | loading | tablet | 834 px |
| 130 | 2.8 Nettoyage (fenêtre) | loading | desktop | 1440 px |
| 131 | 2.8 Nettoyage (fenêtre) | loading | wide | 1920 px |
| 132 | 2.8 Nettoyage (fenêtre) | error | phone | 390 px |
| 133 | 2.8 Nettoyage (fenêtre) | error | tablet | 834 px |
| 134 | 2.8 Nettoyage (fenêtre) | error | desktop | 1440 px |
| 135 | 2.8 Nettoyage (fenêtre) | error | wide | 1920 px |
| 136 | 2.8 Nettoyage (fenêtre) | hover | desktop (cadre réduit) | 480 px |
| 137 | 2.9 Sujet archivé | default | phone | 390 px |
| 138 | 2.9 Sujet archivé | default | tablet | 834 px |
| 139 | 2.9 Sujet archivé | default | desktop | 1440 px |
| 140 | 2.9 Sujet archivé | default | wide | 1920 px |
| 141 | 2.9 Sujet archivé | empty | phone | 390 px |
| 142 | 2.9 Sujet archivé | empty | tablet | 834 px |
| 143 | 2.9 Sujet archivé | empty | desktop | 1440 px |
| 144 | 2.9 Sujet archivé | empty | wide | 1920 px |
| 145 | 2.9 Sujet archivé | loading | phone | 390 px |
| 146 | 2.9 Sujet archivé | loading | tablet | 834 px |
| 147 | 2.9 Sujet archivé | loading | desktop | 1440 px |
| 148 | 2.9 Sujet archivé | loading | wide | 1920 px |
| 149 | 2.9 Sujet archivé | error | phone | 390 px |
| 150 | 2.9 Sujet archivé | error | tablet | 834 px |
| 151 | 2.9 Sujet archivé | error | desktop | 1440 px |
| 152 | 2.9 Sujet archivé | error | wide | 1920 px |
| 153 | 2.9 Sujet archivé | hover | desktop (cadre réduit) | 480 px |
