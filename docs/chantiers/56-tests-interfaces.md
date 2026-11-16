# Chantier 56 : les tests des interfaces

| Champ | Valeur |
|---|---|
| État | **Révision 0, 16 novembre 2026.** Demandé par Julien : « sur les sujets avec interface, souvent un CTA n'a pas le bon comportement, une action est impossible… il faut vraiment une politique de test sur les interfaces ». Julien a choisi l'ordre « audit, puis garde ». |
| Emplacement final | `docs/chantiers/56-tests-interfaces.md` sur `main` |
| Base | `main`. |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI code sur un brief tiré de ce plan. La cell de gestion relit le diff, regarde les captures, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | CI verte et oui de Julien. Le chantier ne touche ni le mesh ni la sécurité : pas de relecture du lab, sauf si un correctif touche le mode host, le PDA ou le proxy. |

## 1. Le constat

Les gates sont verts, et pourtant Julien trouve souvent, à l'usage, un bouton qui ne fait pas ce qu'il dit, ou une action impossible. Les tests web vérifient surtout que l'écran s'affiche. Les e2e suivent des parcours choisis à la main : rien ne garantit que chaque bouton est cliqué au moins une fois, ni qu'un bouton désactivé devient utilisable dans un cas réel.

## 2. Les décisions

| # | Décision | Source |
|---|---|---|
| **D342** | **La politique, pour tout point qui touche l'interface**, à partir du 31.14 :<br>1. Chaque bouton, lien ou formulaire ajouté ou modifié est **cliqué par un e2e**, dans le vrai navigateur et contre le vrai daemon. Seuls les services extérieurs sont simulés : le proxy, Tailscale, le CLI swarph, claude, codex et gh. Le test vérifie ce que l'utilisateur voit, et aussi l'effet côté serveur.<br>2. **Aucun bouton désactivé pour toujours** : pour chaque bouton qui peut être désactivé, un test le montre actif dans un cas réel, puis le clique.<br>3. **Le cas d'erreur** : chaque action a un test où le serveur refuse. L'écran affiche le message, et l'utilisateur peut recommencer.<br>4. **La revue visuelle** : avant le commit, la cell de gestion regarde les captures de l'e2e, en format bureau (1280 × 800) et en format téléphone (390 × 844).<br>5. **Le garde** (D345) fait échouer la CI si un bouton n'est cliqué par aucun e2e. | Julien, 16 novembre. |
| **D343** | **L'explorateur.** C'est un outil d'audit, hors du gate : `npm run audit:ui`, avec sa propre config Playwright (`playwright.audit.config.ts`) et ses fichiers sous `e2e/audit/`.<br>• **Ce qu'il démarre.** Un daemon isolé, avec les faux de l'e2e : un dépôt, un sujet, un serveur, un mesh avec son board et un faux proxy, le mode host actif avec une sortie synthétique de `tailscale`, et un appareil appairé. Aucun réseau, aucun vrai nom.<br>• **Ce qu'il parcourt.** Chaque route de `web/src/App.tsx`, avec un id réel pour les routes paramétrées, puis l'app de l'appareil et l'app du PDA. Il passe chaque écran dans les deux formats de D342.<br>• **Sur chaque écran**, il prend une capture, puis il liste les éléments interactifs visibles : `button`, `a[href]`, `[role=button]`, `summary`, `input`, `select`, `textarea`. Pour chacun, il relève le `data-node` (ou son absence), le texte, l'état actif ou désactivé, et le `title`.<br>• **Il clique chaque élément actif**, sur une page rechargée à neuf. Il attend 1,5 s, puis il relève les erreurs de la console, les erreurs de page, les réponses ≥ 400 (chemin et statut, jamais le corps), la navigation, les mutations du DOM et les requêtes parties.<br>• **Il classe chaque élément :** `erreur` (une erreur de la console ou de page, ou une réponse 5xx), `refus` (une réponse 4xx), `sans effet` (ni requête, ni navigation, ni mutation), `desactive` (jamais actif sur cet écran), `ok`.<br>• **Les exclusions.** Une liste écrite dans le code, avec la raison de chaque entrée. Elle couvre les boutons qui arrêtent le daemon ou ouvrent un programme externe. Si le daemon ne répond plus après un clic, l'explorateur le note et le redémarre.<br>• **Le rapport** est écrit sous `$TMPDIR/aid-audit-ui/` : `rapport.json`, un `rapport.md` trié par gravité, et les captures. Rien de tout cela n'est commité. | Julien : « audit, puis garde ». |
| **D344** | **Le tri de l'audit.** La cell de gestion lit le rapport et regarde les captures, puis elle trie :<br>• les vrais défauts, regroupés par écran ;<br>• les faux positifs de l'explorateur (un `sans effet` qui en a bien un, comme une copie dans le presse-papiers), corrigés dans l'explorateur ;<br>• les boutons désactivés à bon droit, avec le cas réel qui les rend actifs.<br>Elle montre la liste à Julien. Chaque groupe de défauts devient un point de correctif, avec son e2e qui clique (D342). | — |
| **D345** | **Le garde de couverture.**<br>• **Le relevé des clics.** Un script d'init (`context.addInitScript`), posé par une fixture commune à tous les e2e, écoute les clics en phase de capture. Il note le `data-node` le plus proche de chaque clic. À la fin de chaque test, la fixture ajoute ces ids à un fichier de relevé sous `$TMPDIR`.<br>• **L'inventaire.** L'explorateur en sort un : `e2e/audit/inventaire.json`, commité, avec les `data-node` des éléments interactifs, normalisés (les segments variables, comme un id de sujet, sont remplacés par `*`).<br>• **Le contrôle.** Après `gate:e2e`, `npm run couverture:ui` compare le relevé à l'inventaire. Un élément de l'inventaire qui n'a jamais été cliqué fait échouer la CI, sauf s'il figure dans `e2e/audit/non-couverts.json`, avec une raison.<br>• **Le cliquet.** La liste `non-couverts.json` part de l'état de l'audit, et elle ne peut que diminuer. Un élément nouveau ne peut pas y entrer sans une raison relue par la cell de gestion.<br>• **Un élément interactif sans `data-node`** compte comme non couvert. | Julien : « audit, puis garde ». |

## 3. Les points

### 56.1 Le plan

Ce document.

### 56.2 L'explorateur (D343)

- L'outil `npm run audit:ui` et sa config. Le démarrage du daemon réutilise les aides de `e2e/` (`helpers.ts`, `host-helpers.ts`, `helpers-multi-mesh.ts`, `serve-local.ts`).
- **Tests :**
  - un test unitaire du classement, sur des relevés synthétiques ;
  - un essai de l'explorateur sur deux écrans, joué en CI pour qu'il ne pourrisse pas, sans faire échouer la CI sur ses trouvailles.

### 56.3 L'audit et son tri (D344)

La cell de gestion lance l'explorateur, regarde le rapport et les captures, puis montre la liste à Julien. Le plan reçoit la liste des points de correctif, de 56.4 à 56.n.

### 56.4 à 56.n Les correctifs

Un point par écran ou par groupe d'écrans. Chacun respecte D342 : un e2e qui clique, le cas réel qui active le bouton, le cas d'erreur, et la revue des captures.

### 56.g Le garde (D345)

Il vient après les correctifs, pour que la liste de départ soit courte.

## 4. Pièges

- **L'explorateur clique tout.** Il ne tourne que contre un daemon isolé, avec les faux de l'e2e. Jamais contre le daemon de Julien, jamais avec le vrai claude, codex, gh, tailscale ni swarph.
- **Les ports.** Ceux de l'e2e (4871 à 4873, 4891 à 4893), via `AID_E2E_PORT`. L'explorateur ne tourne pas en même temps qu'un `gate:e2e`.
- **Le rapport et les captures** restent sous `$TMPDIR`. Les données sont synthétiques, mais rien n'est commité, sauf l'inventaire.
- **Aucun vrai nom** de cell, de dépôt ni d'hôte dans les fixtures (garde des noms neutres, 49 et 54).

## 5. Fini quand

- 56.2 à 56.g sont mergés, avec la CI verte et le oui de Julien.
- La liste `non-couverts.json` ne contient que des éléments justifiés.
