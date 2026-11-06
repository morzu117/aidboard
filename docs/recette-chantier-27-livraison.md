# Recette de l'écran Livraison (chantier 27)

Grille du point 27.10 du plan `docs/chantiers/27-livraison.md`. Deux niveaux :

- **couverture automatique** : ce que `npm run gate` et `npm run gate:e2e` vérifient déjà. Ce sont
  les tests unitaires de l'écran et `e2e/livraison.spec.ts`. Ce spec tourne sur un daemon à part,
  en `stream`, avec le faux `gh` (`AID_GH_BIN` = `test/fixtures/fake-gh.sh`) et le journal de ses
  merges. Jamais le vrai `gh` ni le vrai claude, aucun réseau, aucun token.
- **recette réelle** : sur le vrai cockpit de Julien, avec un vrai `gh` authentifié, **sur un dépôt
  jetable à lui, jamais `aidboard`**, sous Node 22 puis sous Node 24. Aucune case de cette partie
  ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents. La recette se fait sur une instance à
  part, lancée depuis le worktree de la branche. Rien n'est lancé, redémarré ni réinstallé sur le
  daemon de travail sans l'accord de Julien ;
- le merge de la recette est réel : il fusionne la PR du dépôt jetable sur GitHub.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| `git/livraison` : tête, merge-base sur `origin/<base>`, fichiers, empreinte du diff ; position d'un commit de revue (D125) | `test/topic-livraison.test.ts` |
| `topic.merge` avec `head` : `--match-head-commit`, refus « Head branch was modified » remonté (D123) | `test/topic-merge.test.ts` |
| `pr.rafraichir` lit `headRefOid`, `state`, `number`, `baseRefName` ; `topic.test` enregistre sa tête ; `diff.ouvrir-fichier` accepte `depuis` (D124, D135) | `test/topic-pr-refresh.test.ts`, `test/topic-test.test.ts`, `test/editor.test.ts` |
| `/api/state` porte `agentTransport` (D129) | `test/state.test.ts` |
| Contrôles, fraîcheur, raison du blocage et son ordre, citations, avis (la dernière section d'une page complétée en append), message de revue (D126, D127, D129 à D131) | `test/web/livraison-vue.test.ts` |
| L'écran : titre sur la tête, contexte, bandeau de tête locale et Pousser, fichiers et diff dans l'éditeur, Ouvrir la PR, Relire ; tuiles, contrôles exécutés, avis ; Autoriser le merge et sa confirmation, refus affiché puis relecture ; Relancer la revue, PTY désactivé (D121 à D135) | `test/web/livraison.test.tsx` |
| `?onglet=review` ; onglet Livraison du panneau ; Livrer sur l'accueil (D131, D133, D134) | `test/web/sujet-colonnes.test.tsx`, `test/web/panneau-contexte.test.tsx`, `test/web/accueil.test.tsx` |
| De bout en bout : sans PR, merge bloqué ; Ouvrir la PR, relue ; page `review` à jour, puis obsolète après un commit poussé, merge bloqué ; revue complétée en append sur la nouvelle tête ; onglet Livraison, Livrer sur l'accueil ; merge confirmé, `--match-head-commit <tête>` au journal du faux gh | `e2e/livraison.spec.ts` |

Non couvert en e2e :
- Relancer la revue (agent lancé, message, navigation), couvert par les tests de l'écran ;
- le bandeau de tête locale, que le faux gh ne peut pas produire : il rend toujours HEAD comme tête
  de la PR. Il est couvert par les tests de l'écran.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/27-livraison` (head : _à noter_), sous
  Node 22 (`node --version` : _à noter_)
- [ ] `gh auth status` est vert, sur le compte qui possède le dépôt jetable
- [ ] Un dépôt jetable enregistré comme projet, avec un sujet et au moins un commit sur sa branche

## Recette réelle

- [ ] 27.10.1 Ouvrir la Livraison du sujet (onglet Livraison du panneau, puis « Ouvrir la vue
  livraison »). Sans PR, on doit voir :
  - le titre « Peut-on livrer `<tête locale>` ? » ;
  - la ligne branche → base · diff · N fichiers ;
  - « PR vers main ○ à créer » ;
  - « Bloqué : aucune PR ouverte. »
  - Constat : _à remplir_
- [ ] 27.10.2 « Ouvrir la PR », titre prérempli. La PR apparaît sur GitHub et la ligne passe à
  « ● #N ouverte », avec le lien. La PR est relue : le titre porte sa tête.
  - Constat : _à remplir_
- [ ] 27.10.3 Un clic sur un fichier ouvre son diff merge-base...tête dans l'éditeur.
  - Constat : _à remplir_
- [ ] 27.10.4 Contrôles : ceux de GitHub, s'il y en a, avec leur durée, plus « npm test (local) »
  après « Relancer le test local ». Un test lancé sur une autre tête est grisé, « sur `<sha>` ».
  - Constat : _à remplir_
- [ ] 27.10.5 « Relancer la revue » avec codex. Le sujet s'ouvre sur l'agent, qui a reçu le message.
  Une fois la page `review` écrite, la tuile Revue dit « À jour », et l'avis montre son premier
  paragraphe, ses lignes Examiné et Non examiné.
  - Constat : _à remplir_
- [ ] 27.10.6 Un commit de plus, sans pousser : le bandeau « La tête locale … n'est pas sur la PR »
  apparaît. Pousser, puis la PR est relue. La tuile Revue dit « Obsolète · 1 commit de retard »,
  l'encart le dit, et le merge est « Bloqué : la revue ne porte pas sur cette tête. »
  - Constat : _à remplir_
- [ ] 27.10.7 Relancer la revue sur la nouvelle tête : « À jour », et l'avis est le nouveau.
  « Autoriser le merge de `<tête>` », puis le dialogue « Fusionner `<tête>` dans main ? » avec ce
  qui est cité. Merge commit, branche gardée. La PR est fusionnée sur GitHub ; la tuile Autorisation
  dit « Fusionnée · Sur `<tête>` » et la ligne PR « ● fusionnée ».
  - Constat : _à remplir_
- [ ] 27.10.8 Sur un second sujet avec PR : pousser un commit depuis un autre clone pendant que
  l'écran est ouvert, puis confirmer le merge sans relire. GitHub refuse, et le refus s'affiche tel
  quel sous le bouton. La PR est relue et le titre passe à la nouvelle tête.
  - Constat : _à remplir_
- [ ] 27.10.9 L'accueil montre « Livrer » sur un sujet dont la PR est ouverte ; il mène à l'écran.
  - Constat : _à remplir_
- [ ] 27.10.10 Les mêmes points 27.10.1, 27.10.6, 27.10.7 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] Ordre des raisons de blocage (D127) : la fusion déjà faite vient en premier (le plan la
  mettait en dernier), sinon un sujet fusionné afficherait une autre raison.
- [ ] Pendant une lecture (PR, dépôt, revue), le bouton de merge attend, désactivé, sans annoncer de
  raison ; la tuile Revue dit « Lecture… ».
- [ ] Un refus du merge ferme le dialogue et reste sous le bouton : une tête qui a bougé n'est
  jamais confirmable dans le même dialogue.
- [ ] Le message de revue demande d'écrire en mode append avec un titre « ## Revue de `<tête>` » :
  l'avis lu est la dernière de ces sections.
- [ ] « Relancer la revue » devient l'action principale quand la revue est obsolète.

## Ce qui n'est pas couvert

- La confirmation au téléphone et son expiration (chantiers 34 et 43).
- Les critères, la carte et la tête publiées sur le board (35, 36), toute écriture sur le board.
- Les findings, corrections, lot et motifs d'écart ; le diff en ligne.
- La distinction panne d'environnement / échec ; relancer un contrôle GitHub.
- `pr.rafraichir` ne vérifie pas `gh auth status` : sans authentification, l'erreur de `gh` est
  montrée telle quelle dans le bandeau « La PR n'a pas pu être relue ».
