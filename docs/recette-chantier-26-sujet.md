# Recette de l'écran Sujet (chantier 26)

Grille du point 26.10 du plan `docs/chantiers/26-ecran-sujet.md`. Deux niveaux :

- **couverture automatique** — ce que `npm run gate` et `npm run gate:e2e` vérifient déjà : tests
  unitaires de l'écran, et `e2e/sujet.spec.ts` sur un daemon à part, en `stream`, devant le faux
  claude structuré (`test/fixtures/bin-stream`). Jamais le vrai claude, aucun réseau, aucun token.
- **recette réelle** — sur le vrai cockpit de Julien, sous Node 22 puis sous Node 24. Aucune case
  de cette partie ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents : la recette se fait sur une instance à
  part, lancée depuis le worktree de la branche ; rien n'est lancé, redémarré ni réinstallé sur le
  daemon de travail sans l'accord de Julien ;
- Archiver, dans cette recette, ne touche que la barre (`placement.archived`) : le sujet et son
  worktree restent. Désarchiver avant de finir.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| État d'un onglet d'agent en mots, « ouvert » pour un shell vivant ; segments de phase et ligne « Phase N sur 5 » (D113, D115) | `test/web/sujet-vue.test.ts` |
| Nom affiché dans l'en-tête et la barre, d'où qu'il change (D111) ; Renommer, Épingler, Archiver depuis le menu ··· (D112) | `test/web/sujet-entete.test.tsx` |
| Barre des phases, prochaine chose, ambre sur une question (D113, D114) ; onglets : état, rôle seulement pour la chaîne (D115) ; « Voir la question » choisit l'agent (D119) | `test/web/sujet-entete.test.tsx`, `test/web/sujet.test.tsx` |
| « Mac local » sur une réponse, le serveur sur une discussion distante (D120) ; chips Permissions et Profil, « Interrompre » (D116, D117) | `test/web/conversation.test.tsx`, `test/web/discussion.test.tsx`, `test/web/commandes.test.ts` |
| Menu `@` : aplatir, filtrer, insérer ; une lecture par ouverture ; arbre tronqué ; rien sans sujet (D118) | `test/web/fichiers-mention.test.ts`, `test/web/composer-fichiers.test.tsx` |
| Onglet Sujet, prochaine décision ; index en tête de Fichiers (D119) | `test/web/panneau-contexte.test.tsx`, `test/web/sujet.test.tsx` |
| De bout en bout : onglet « libre » sans rôle ; renommer et le voir dans la barre, épingler, archiver, et revenir ; Permissions, Profil « Mac local », un tour « Mac local » interrompu ; `@` insère `@README.md` ; question en attente dans l'onglet Sujet, Voir la question ; index dans Fichiers | `e2e/sujet.spec.ts` ; `/mode` et son avis : `e2e/commandes-slash.spec.ts` ; repli de l'index : `e2e/repli-index.spec.ts` |

Non couvert en e2e : la barre des phases (aucune route ne pose une phase sur le daemon des e2e),
couverte par les tests unitaires de l'en-tête.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/26-ecran-sujet` (head : _à noter_), sous
  Node 22 (`node --version` : _à noter_)
- [ ] Un projet avec au moins un sujet où tourne un claude, et si possible un sujet en phase (chaîne
  plan → rétro)

## Recette réelle

- [ ] 26.10.1 En-tête : sous le titre, la barre de cinq segments et « Phase N sur 5 · … » quand le
  sujet a une phase, rien sinon ; la prochaine chose à droite, ambre quand une question attend.
  - Constat : _à remplir_
- [ ] 26.10.2 Menu ··· : Renommer remplace le titre par un champ ; Entrée garde, Échap annule ; le
  nouveau nom s'affiche aussi dans la barre gauche. Épingler, puis Désépingler ; Archiver, puis
  Désarchiver : la barre suit à chaque fois.
  - Constat : _à remplir_
- [ ] 26.10.3 Onglets d'agents : chacun dit son état en mots (au travail, attend ta réponse, libre,
  en veille…) ; un agent lancé à la main n'a pas de rôle, un agent de la chaîne a le sien.
  - Constat : _à remplir_
- [ ] 26.10.4 Fil et zone de saisie : chaque réponse porte « Mac local » ; le chip Permissions dit
  « Demander avant d'écrire » et son menu les quatre permissions ; le Profil dit agent · modèle ·
  machine ; pendant un tour, « Interrompre » l'arrête sans fermer l'agent.
  - Constat : _à remplir_
- [ ] 26.10.5 `@` dans le champ : la liste des fichiers du worktree, filtrée par la saisie ; Entrée
  ou un clic insère `@chemin`. Sur une discussion de serveur, `@` n'ouvre rien.
  - Constat : _à remplir_
- [ ] 26.10.6 Panneau : l'onglet s'appelle Sujet ; une question en attente y est en tête, ambre,
  et « Voir la question » choisit l'onglet de l'agent qui la pose. L'état de l'index n'est plus
  dans l'en-tête ; s'il n'est pas prêt, il est en tête de l'onglet Fichiers.
  - Constat : _à remplir_
- [ ] 26.10.7 Les mêmes points 26.10.1, 26.10.4, 26.10.6 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] Un shell vivant se lit « ouvert » dans son onglet : D115 ne nommait pas ce cas.
- [ ] La prochaine chose sous une phase ne répète pas la phase (la ligne la dit déjà) : elle donne
  l'état de l'agent, ou « En cours ».

## Ce qui n'est pas couvert

- La Conduite (Q2), l'onglet Livraison (Q4, chantier 27) et Reprendre (Q5, chantier 28).
- Le Profil ne règle que le modèle ; l'agent et la machine se lisent sans se changer (Q3).
