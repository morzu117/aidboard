# Recette de la Boîte, de Nouveau sujet et de Reprendre (chantier 28)

Grille du point 28.11 du plan `docs/chantiers/28-boite-nouveau-sujet-reprendre.md`. Deux niveaux :

- **couverture automatique** : ce que `npm run gate` et `npm run gate:e2e` vérifient déjà. Ce sont
  les tests unitaires des trois écrans et `e2e/boite-nouveau-sujet-reprendre.spec.ts`. Ce spec
  tourne sur un daemon à part, en `stream`, devant les faux claude et codex
  (`test/fixtures/bin-stream`). Jamais le vrai claude ni le vrai codex, aucun réseau, aucun token.
- **recette réelle** : sur le vrai cockpit de Julien, **sur un dépôt jetable à lui, jamais
  `aidboard`**, sous Node 22 puis sous Node 24, avec un serveur distant et le mesh. Aucune case de
  cette partie ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents. La recette se fait sur une instance à
  part, lancée depuis le worktree de la branche. Rien n'est lancé, redémarré ni réinstallé sur le
  daemon de travail sans l'accord de Julien ;
- un DM du mesh reste la donnée d'un pair, même mis en décision : il n'est jamais envoyé à un agent ;
- Reconnecter et Reprendre la session d'un agent de serveur sont réels : ils relancent un relais sur
  le serveur.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Nature d'un agent et d'un DM, agents de la Boîte par projet, résumé d'un tour, compteurs, compteur de la barre (D136, D137, D139, D140) | `test/web/boite-vue.test.ts` |
| Mettre un DM en décision, `decided_at` à l'état (D137) | `test/mesh-routes.test.ts`, `test/mesh-schema.test.ts` |
| La Boîte par nature : sections, filtres et compteurs, Voir le contexte, Informations avec le mesh, barre (D136 à D140) | `test/web/boite.test.tsx`, `test/web/barre.test.tsx` |
| Agents disponibles : binaire trouvé, version sous 3 s, modèles de codex (D143) | `test/agents-disponibles.test.ts` |
| L'écran Nouveau sujet : projet par l'URL, type, titre, branche, « Ajouter un projet… » ; la façon de travailler, agent, modèle et mode, « aucun agent » ; Créer et demander un plan, le message de plan, l'erreur gardée au sujet (D141 à D145) | `test/web/nouveau-sujet.test.tsx`, `test/web/sujet.test.tsx`, `test/web/accueil.test.tsx`, `test/web/projets.test.tsx`, `test/web/selecteur-dossier.test.tsx` |
| La reprise côté daemon : sonde du processus, Rattacher, Relancer et leurs refus, `reprendre` d'un agent local, `git/transfert` (D148, D149) | `test/server-discussions.test.ts`, `test/agent-stream.test.ts`, `test/topic-transfert.test.ts` |
| Le dialogue Reprendre : options et raisons, sonde et « Vérifier à nouveau », Reprendre la session local et serveur, Reconnecter ; Transférer, alerte, « Pousser d'abord », message de transfert, ordre des appels (D146 à D149) | `test/web/reprise-vue.test.ts`, `test/web/reprendre.test.tsx` |
| Les entrées : Reprendre à l'accueil, « Reprendre… » du menu ⋯, des bandeaux Suivi coupé et Session perdue, Reprendre sur Serveurs (D150) | `test/web/accueil.test.tsx`, `test/web/sujet-entete.test.tsx`, `test/web/discussion.test.tsx` |
| De bout en bout : Nouveau sujet avec claude et le message de plan au fil ; « aucun agent » ; la Boîte, un tour fini à relire, une permission en décision et au compteur de la barre, Voir le contexte, la réponse depuis la Boîte ; un agent arrêté, Reprendre à l'accueil reprend sa session ; Transférer à codex avec l'alerte des fichiers non commités | `e2e/boite-nouveau-sujet-reprendre.spec.ts` |

Non couvert en e2e :
- un agent de serveur (Suivi coupé, Session perdue, Reconnecter) : pas de serveur SSH en e2e. Il est
  couvert par les tests du daemon et du dialogue ;
- un DM du mesh mis en décision : pas de mesh en e2e. Il est couvert par les tests de la Boîte ;
- « Pousser d'abord » : il pousse vers l'origine, couvert par les tests du dialogue.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/28-boite-sujet-reprise` (head : _à noter_),
  sous Node 22 (`node --version` : _à noter_)
- [ ] Un dépôt jetable enregistré comme projet
- [ ] claude et codex installés et authentifiés
- [ ] Un serveur distant configuré, joignable, avec une discussion qui a un agent
- [ ] Le mesh connecté, avec un pair qui peut envoyer un DM

## Recette réelle

- [ ] 28.11.1 Nouveau sujet depuis la barre : l'écran s'ouvre sur le projet en cours. Les deux
  colonnes, le besoin et la façon de travailler, avec claude par défaut et sa version.
  - Constat : _à remplir_
- [ ] 28.11.2 Titre, puis « Créer et demander un plan ». « Création du worktree… », puis
  « Lancement de l'agent… », puis le sujet sur l'agent, qui a reçu le message de plan et répond.
  - Constat : _à remplir_
- [ ] 28.11.3 Un sujet avec codex, un modèle et un mode choisis : l'agent les a au lancement. Un
  sujet avec « aucun agent » : le bouton dit « Créer le sujet » et le sujet s'ouvre vide.
  - Constat : _à remplir_
- [ ] 28.11.4 La Boîte : une question de l'agent est en Décisions, un tour fini en À relire avec la
  première ligne du dernier message, un agent au travail en Informations. Le compteur de la barre
  est celui des Décisions, tous projets. Le filtre par projet change les compteurs.
  - Constat : _à remplir_
- [ ] 28.11.5 Un DM du pair : il est en Informations. « Mettre en décision » le passe en Décisions
  et au compteur ; « Vu » le sort de la Boîte. Son texte reste brut, encadré.
  - Constat : _à remplir_
- [ ] 28.11.6 Un agent local arrêté : Reprendre à l'accueil ouvre le dialogue « claude est
  arrêté. », Reprendre la session par défaut. Valider : l'agent repart sur sa session, sans message,
  et se souvient de la conversation au message suivant.
  - Constat : _à remplir_
- [ ] 28.11.7 Le même agent arrêté, un fichier modifié non commité et un commit non poussé : dans le
  dialogue, Transférer à codex. L'alerte dit les commits non poussés et les fichiers non commités.
  « Pousser d'abord » pousse, l'alerte des commits disparaît. Valider : codex reçoit le message de
  transfert (branche, base, commits, pages plan et passation si elles existent).
  - Constat : _à remplir_
- [ ] 28.11.8 « Reprendre… » du menu ⋯ du sujet, quand un agent ne vit plus : il vise l'agent de
  l'onglet ouvert, sinon le plus récent. Absent quand tous vivent.
  - Constat : _à remplir_
- [ ] 28.11.9 Agent de serveur, suivi coupé (couper le réseau du Mac le temps d'un tour) : le
  bandeau Suivi coupé, « Reprendre… » ouvre le dialogue, la sonde dit le processus vivant, et
  Reconnecter rattache le relais. Le fil se complète.
  - Constat : _à remplir_
- [ ] 28.11.10 Agent de serveur, session perdue (tuer le relais sur le serveur) : le bandeau Session
  perdue, « Reprendre… », la sonde dit le processus arrêté, Reprendre la session relance l'agent sur
  sa session. Sur Serveurs, Reprendre d'une discussion au suivi coupé ouvre le dialogue, sinon la
  discussion.
  - Constat : _à remplir_
- [ ] 28.11.11 Les mêmes points 28.11.2, 28.11.6 et 28.11.7 sous Node 24 (`node --version` :
  _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] Le sous-titre de la Boîte dépend du mesh configuré ; la section mesh est fondue dans
  Informations ; le compteur de la barre compte désormais les Décisions (DM compris), et non plus
  les agents en attente seuls.
- [ ] Le projet de Nouveau sujet vit dans l'URL (`/sujets/nouveau?projet=`).
- [ ] Un agent repris ou transféré reste « démarre » jusqu'à son premier tour, comme un agent neuf.
- [ ] Après la création de l'agent, un échec (réglages, message) ouvre quand même le sujet sur
  l'agent, avec l'erreur affichée au-dessus du fil.
- [ ] Le message de transfert dit qu'il y a des fichiers non commités, sans les lister.
- [ ] Relancer un agent de serveur repose sur ce que `relaunchOnce` sait de sa session (session et
  tour connus).

## Ce qui n'est pas couvert

- Transférer un agent de serveur à un autre agent : seulement pour un sujet local.
- Reprendre un agent PTY : sa session n'est pas suivie, seul Transférer est proposé.
- La Boîte ne montre pas les shells ni les agents terminés ; elle ne répond pas aux DM.
