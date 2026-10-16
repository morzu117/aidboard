# Recette de la v0.2 Statuts

Grille du plan 06.12. Les cases cochées sont couvertes par les gates (`npm run gate`, `npm run gate:e2e`) sur macOS.
Les e2e jouent toute la chaîne PTY → hook → daemon → UI avec le faux `claude` des fixtures, jamais le vrai. Les cases
vides demandent un humain avec une vraie session `claude` (quota d'abonnement).

## Avant de commencer

1. `aid stop` puis `aid` : un daemon lancé avant la v0.2 tourne sur l'ancien code, sans hooks ni routes de pilotage.
2. Réglages → Hooks → « Installer les hooks », puis confirmer (ou `aid hooks install`). `~/.claude/settings.json` est
   sauvegardé en `settings.json.aid-<horodatage>.bak` avant d'être modifié ; `aid hooks status` doit dire « installés ».
3. **Relancer les sessions `claude` déjà ouvertes** : Claude Code ne relit ses hooks qu'au démarrage.
4. Réglages → Notifications → autoriser.

## Couvert par les gates

- [x] Un « claude » qui demande une permission : la carte passe à « Attend une réponse » avec la demande, la 1.2 la
      range dans « Attend une réponse », le compteur de la barre passe à 1 (e2e `pilotage`)
- [x] Répondre depuis la 1.2 : la touche arrive dans le terminal, le compteur retombe, l'agent repart (e2e `pilotage`)
- [x] `Stop` → « À relire » sur la carte (e2e `pilotage`)
- [x] Un message envoyé par la carte arrive dans le terminal (e2e `pilotage`, shell)
- [x] Pause : process en état `T` (`ps`), carte « En pause », saisie impossible ; reprise : le terminal répond (e2e `pilotage`)
- [x] Palette ⌘K : filtre, Entrée, Échap ; jamais captée dans un terminal (e2e `pilotage`, `test/web/barre.test.tsx`)
- [x] Un dépôt sans `origin` s'enregistre avec un avertissement ; son sujet se crée, tourne et se nettoie (e2e `pilotage`)
- [x] Réponse refusée par le daemon quand l'écran ne montre plus l'option : 409, rien n'est tapé (`test/agents-pilotage.test.ts`)
- [x] Un `claude -p` lancé par l'agent ne change pas son statut (lignée de process, `test/statuts.test.ts`)
- [x] Sans hooks : statuts « estimé » depuis le terminal, infobulle (`test/heuristique.test.ts`, `test/web/carte.test.tsx`)
- [x] Une notification par demande, onglet caché seulement, pas de rafale au chargement ; titre « (N) A-I-D »
      (`test/web/notifications.test.tsx`)

## Avec un vrai `claude`

- [ ] Dans un sujet, lancer `claude` et lui demander une commande Bash non autorisée (« lance `ls -la` ») : la carte de
      l'Accueil passe à « Attend une réponse » **sans « · estimé »**, avec « claude demande : autoriser Bash(ls -la) ? »
- [ ] La 1.2 montre l'élément sous « Attend une réponse » ; cliquer « Autoriser une fois » : Claude exécute la commande,
      l'élément quitte « Attend une réponse », le compteur de la barre retombe
- [ ] Même chose avec « Refuser » : Claude n'exécute rien et rend la main ; la carte passe à « À relire »
- [ ] Si `permission_suggestions` est proposé (« Yes, and don't ask again… »), le bouton « Toujours … » apparaît et
      répond `2`
- [ ] Une question `AskUserQuestion` à choix unique (« pose-moi une question avec trois options avant de continuer ») :
      la carte montre la question et ses options ; en cliquer une la sélectionne dans Claude
- [ ] Une question à choix multiples : pas de boutons, seulement « Ouvrir le terminal → », qui ouvre l'onglet de cet agent
- [ ] Fin d'un tour : « À relire » sur la carte, « Tour terminé » dans la 1.2 avec la première ligne du dernier message
- [ ] **Sous-session (E3)** : demander à Claude de lancer `claude -p "dis bonjour"` dans Bash ; la carte de l'agent
      parent ne passe **pas** à « À relire » quand la sous-session s'arrête
- [ ] Onglet caché (autre onglet au premier plan), déclencher une permission : une notification du système
      « claude attend ta réponse » ; un clic ramène sur le terminal de l'agent ; une seule notification pour la demande
- [ ] Consigne à tous les agents : envoyée à un `claude` inactif, jamais à un shell
- [ ] Pause pendant un tour de Claude, puis Reprendre : le tour continue là où il s'était arrêté
- [ ] `aid hooks uninstall` : les entrées A-I-D disparaissent de `settings.json`, le reste est intact ; les cartes
      reviennent aux statuts « estimé » après relance de `claude`

## Ce que la recette a révélé (corrigé)

| Défaut | Effet | Garde-fou ajouté |
| --- | --- | --- |
| `approval.resolved` vidait la demande sans changer le statut | une permission accordée depuis A-I-D restait « Attend une réponse » sans question, dans le compteur et la 1.2, jusqu'au hook suivant (tout le temps d'un long `npm test`) | répondue → `working`, refusée → `idle` ; `test/statuts.test.ts`, e2e `pilotage` |
| L'explorateur de dossiers réécrivait le champ à l'arrivée du premier chargement | un chemin tapé avant la réponse était remplacé, et Entrée ouvrait le mauvais dossier | `test/web/selecteur-dossier.test.tsx` |
