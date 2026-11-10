# Chantier 35 bis : l'envoi réel des écritures qui parlent, par le proxy de #20

| Champ | Valeur |
|---|---|
| État | **Révision 0, 9 novembre 2026.** Spec rév. 2 (morzu-vps), d'après le contrat du proxy de #20, draft 2 avec le §10 (DM 93670 et 93673), et les réponses du lab à L1–L4 (DM 93681). Julien a retenu les trois recos : confirmation du téléphone, le 35 bis avant le 36, l'installation du proxy sur son Mac par lui-même. |
| Emplacement final | `docs/chantiers/35bis-envoi-reel.md` sur `main`, dans le premier commit du chantier |
| Base | **05ca283** (`origin/main`, PR #137). |
| Organisation | Comme au 35. morzu-vps gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; morzu-vps relit, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le 35 bis : il ouvre la première écriture d'A-I-D sur le mesh. Merge : CI verte, validation du lab, oui de Julien. |
| Bloqué par | Le point 35b.5 attend une installation de `swarph proxy serve` pour le test réel (le build est mergé, PR 702). Le document de schéma est publié : 35b.3 n'attend plus rien. |

## 1. Pourquoi

Le 35 a tout construit sauf l'envoi : le catalogue, l'argv, le nettoyage, l'aperçu et l'UI. L'envoi attendait de ne pas mettre de jeton dans le daemon. Le proxy de #20 le permet : il garde seul le jeton de la cellule, et relaie une liste fermée de verbes sur une socket locale. Le 35 bis branche les trois écritures du 35 sur ce proxy, derrière la confirmation du téléphone du 34.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le catalogue et l'aperçu | `src/shared/ecritures.ts`, `src/daemon/routes/ecritures.ts` | `lireParamsEcriture`, `argvEcriture`, `resumeEcriture`, `lireReponseEcriture`, `POST /api/swarph/ecrire/apercu` (D251 à D256). |
| Le nettoyage | `src/shared/nettoyage.ts` | `nettoyer(texte, {hotesPrives})` (D254). |
| Aucun envoi | `test/daemon/aucun-envoi.test.ts` | D257 : aucun `say`, `send` ou `post` hors du catalogue, aucune route `envoyer`. |
| La porte des confirmations | `src/daemon/confirmations/` | `preparer` / `executer` par action (D225), le réglage (D227, migration 024), la file et le résultat (D230). |
| L'UI | `web/src/ui/EcrireAuMesh.tsx` | La boîte, l'aperçu, « Copier », aucun bouton « Envoyer ». |

Le contrat du proxy (résumé) :
- une ligne JSON `{verb, args, request_id}` par requête, sur une socket Unix ;
- la réponse `{request_id, ok: true, status, body}` pour un 2xx au corps JSON complet, sinon `{request_id, ok: false, error, status?, detail}` ;
- sept codes : `verb_not_allowed`, `bad_args`, `peer_not_allowed`, `proxy_unavailable`, `upstream_unreachable`, `upstream_ambiguous`, `upstream_error` ;
- les verbes qui parlent : `board.cards.say`, `mesh.send`, `channel.post` (et `mesh.mark_read`, hors 35 bis). L'expéditeur est fixé par le proxy ; `obligation_id` et `cc` ne sont pas acceptés.

## 3. Cible et hors-périmètre

**Cible :** un « Envoyer » sous l'aperçu, qui crée une demande de confirmation ; au « oui » du téléphone, le daemon refait la chaîne et envoie par le proxy ; l'UI montre le résultat, y compris l'envoi incertain.

**Hors périmètre :**
- le 36 (obligations, déplacements) ;
- `mesh.mark_read` ;
- le passage des lectures au proxy ;
- l'installation du proxy (Julien, d'après le modèle launchd du build) ;
- tout repli sur le CLI avec jeton.

## 4. Décisions

### D262. Le réglage `mesh.proxySocket`

- Un chemin dans `config.yaml`, sous `mesh`. Vide (par défaut) = pas de proxy.
- Sans proxy, « Envoyer » est désactivé avec « Le proxy de ta cellule n'est pas configuré. Rien ne peut partir ; l'aperçu reste disponible. », et la route d'envoi répond 409 `proxy_absent`.
- Le chemin n'est jamais affiché dans l'UI, ni renvoyé par une route (comme le gateway au 37).

### D263. `ProxyClient`

- `src/daemon/mesh/proxy.ts`. Une connexion par requête ; une ligne envoyée, une ligne lue (au plus 1 Mio), puis fermeture.
- `request_id` : un UUID v4 tiré par le daemon.
- Le délai : le délai amont du proxy publié dans le document de schéma, plus 5 s (L2). Tant qu'il n'est pas publié : **20 s** (15 + 5), dans une constante unique.
- Une liste fermée de verbes : `board.cards.say`, `mesh.send`, `channel.post`. Un autre verbe lève une erreur avant toute connexion.
- Le parseur de réponse est strict :
  - `request_id` différent de celui envoyé, JSON illisible, ligne absente : `format` ;
  - `ok: true` sans `status` 2xx ou sans `body` objet : `format` ;
  - `ok: false` avec un `error` hors des sept codes : `format`.
- Le résultat est discriminé : `{ok: true, status, body}` ou `{ok: false, code}`, avec `code` parmi les sept, plus `delai` (délai dépassé), `interrompu` (coupure après l'écriture), `connexion` (socket absente ou refusée, assimilé à `proxy_unavailable`) et `format`.
- **Avant ou après l'écriture.** `connexion` ne vaut que si la requête n'a pas été écrite sur la socket (socket absente, connexion refusée, erreur avant `connect`). Une erreur ou une fermeture **après** l'écriture de la ligne donne `interrompu` : l'écriture a pu avoir lieu, comme `upstream_ambiguous`. Une réponse `format` reçue après l'écriture se montre aussi comme incertaine dans l'UI (D267).
- `detail` n'est jamais remonté à l'UI ni au journal.

### D264. Les arguments de chaque verbe

Fixés par le document de schéma, `docs/proxy-protocol.md` de swarph-cli (PR 702, mergée le 2026-11-09), § « Argument types » et la table des verbes. Depuis les `params` du 35 :

| Action | Verbe | `args` |
|---|---|---|
| `carte.note` | `board.cards.say` | `{id: carte, content: texte, kind}`, plus `to_node: a` si `a` n'est pas nul |
| `dm.envoyer` | `mesh.send` | `{to_node: pair, content: texte, kind}` |
| `canal.poster` | `channel.post` | `{channel: canal, content: texte, kind}` |

- Aucun autre champ : le schéma est fermé, et le proxy refuse `from_node`, `actor`, `cc`, `thread_id`. Le fil d'une note de carte est lu par le proxy lui-même.
- **Un DM dans un fil** (`fil` non nul) n'a pas d'équivalent : `mesh.send` ne connaît que `reply_to` (un id de message entier), pas l'UUID de fil. `preparer` le refuse en 400 : « Un DM dans un fil ne peut pas encore partir par le proxy. Copie la commande, ou envoie-le hors fil. » `reply_to` n'est pas exposé dans ce chantier.
- Les règles d'A-I-D sont plus strictes que celles du proxy, ou égales : nom `^[a-z0-9][a-z0-9-]{0,62}$` (proxy : `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`), texte de 4 000 caractères au plus (proxy : 200 000), `kind` parmi les cinq du proxy. Aucune valeur n'est convertie.
- Le délai publié est de 15 s en amont, et 20 s côté client : `DELAI_PROXY_MS = 20_000` est confirmé.
- Les tests du 35b.3 citent ces lignes du document de schéma (L4).

### D265. L'envoi sous confirmation

- Une nouvelle action de la porte, `mesh.ecrire`, en classe « par défaut » (Q1). Ses `params` signés : `{ action, params }` du 35, tels que validés.
- Une ligne de réglage `mesh.ecrire`, à 1, dans une migration 025. La couper demande une confirmation (D227) ; la rallumer est immédiate.
- `preparer` refait **toute** la chaîne : `lireParamsEcriture`, `nettoyer`, et le rappel des obligations pour `carte.note`. Il refuse si le proxy n'est pas configuré. Il ne lit rien du client au-delà de `{action, params}`.
- Le résumé signé est `resumeEcriture` (≤ 160 caractères, sans le texte). Le téléphone affiche aussi le texte, en texte brut, avec les autres `params` (D223).
- `executer` appelle `ProxyClient` avec le verbe et les arguments de D264, puis lit `body` par `lireReponseEcriture` : un `closed_obligations` non vide est une erreur.
- Le résultat de la demande (D230) garde : le code, l'id du message s'il y en a un, et les `open_obligations`. **Jamais** le texte.

### D266. La route d'envoi

- `POST /api/swarph/ecrire/envoyer` avec `{ action, params }`. Elle passe par la porte : 202 `{ confirmation: id }`, ou l'exécution directe si le réglage est coupé.
- 404 si le mesh est désactivé ; 409 `proxy_absent` sans proxy ; 400 pour un schéma refusé ; 422 pour un refus de nettoyage (le message, sans le texte).
- Le mode host ne la sert pas (D178).
- Le journal du daemon note l'action, l'id de carte ou le pair, le `request_id` et le code. Jamais le texte ni les `params` complets.

### D267. L'UI de l'envoi

- Sous l'aperçu, un bouton « Envoyer », désactivé sans proxy (D262), au clic, et après un premier envoi depuis le même aperçu.
- Après le clic : « En attente de ta confirmation sur le téléphone. », puis le résultat de la demande.
- Les libellés par code :

| Code | Libellé |
|---|---|
| succès | « Parti. » |
| `proxy_unavailable`, `connexion` | « Le proxy de ta cellule ne répond pas. Rien n'est parti. » |
| `upstream_unreachable` | « Le gateway est injoignable. Rien n'est parti. » |
| `upstream_ambiguous`, `delai`, `interrompu`, `format` | « Envoi incertain : il est peut-être parti. Relis le fil avant de réessayer. » |
| `upstream_error` | « Le gateway a refusé (statut N). » |
| `verb_not_allowed`, `bad_args`, `peer_not_allowed` | « Le proxy a refusé cette écriture (code). C'est un défaut d'A-I-D ou de configuration. » |

- Pour un envoi incertain, aucun bouton « Réessayer ». L'UI propose « Relire le fil » (la carte), ou rappelle de vérifier la Boîte ou le canal.
- Le bandeau « À blanc » du 35 reste quand le proxy n'est pas configuré. Les boutons « Copier » restent.

### D268. D257 réécrit

Le test « aucun chemin d'envoi » devient :
- aucun `'say'`, `'send'` ou `'post'` en argv dans `src/daemon/` ni `src/shared/`, sauf dans `argvEcriture` (qui sert l'aperçu et la copie) ;
- `ProxyClient` n'est importé que par `src/daemon/confirmations/` ;
- aucune route d'écriture autre que `ecrire/apercu` et `ecrire/envoyer` ;
- aucun `spawn` de `swarph` avec un verbe d'écriture.

## 5. Points

### 35b.1 Le plan

Ce document, sur `feat/35bis-envoi-reel`.

### 35b.2 Le client du proxy (D262, D263)

`mesh.proxySocket` dans la config, `src/daemon/mesh/proxy.ts`, et un **faux proxy** de test (`test/fixtures/faux-proxy.ts`), un serveur sur une socket Unix temporaire qui répond selon un scénario. Les tests couvrent : le succès ; chacun des sept codes ; un `request_id` différent ; une ligne illisible ; un `ok: true` sans 2xx ; le délai dépassé ; la socket absente ; un verbe hors liste refusé sans connexion ; `detail` absent du résultat. Ne dépend que du contrat.
- *Révision 35b.2.* `creerProxyClient({socket, delaiMs, uuid})` et `lireReponseProxy(ligne, requestId)`, avec `DELAI_PROXY_MS = 20_000`. Le drapeau « ligne écrite » est posé dès l'appel à `write`, par prudence : après lui, une coupure donne `interrompu`. Le faux proxy (`test/fixtures/faux-proxy.ts`) joue les scénarios du plan. Une ligne existante modifiée (`MeshConfig`). Gate 2753.

### 35b.3 L'action `mesh.ecrire` et la route (D264 à D266, D268)

Après le document de schéma. L'action dans la porte, la migration 025, la route, le test D268, et les tests : la chaîne refaite par `preparer` ; un `params` modifié entre la demande et le « oui » refusé (`perime`) ; `closed_obligations` non vide ; le résultat sans texte ; le mode host ; le journal sans texte.
- *Révision 35b.3.* `src/daemon/confirmations/ecritures.ts` (`creerActionEcriture`), `argsProxy` et `ResultatEnvoi` dans `src/shared/ecritures.ts`, la migration `025_mesh_ecrire.sql`, et la route dans `routes/ecritures.ts`. Un 400 de schéma ne renvoie aucune clé venue du client. Un `closed_obligations` non vide donne le code `obligation-close`, affiché comme un envoi incertain (le web gagne ce code). La réponse du gateway rend toujours les trois clés (lab, L12, DM 94888) : une clé absente est `format`. 41 lignes existantes modifiées. Gate 2805, plus un test instable du chip Remote, vert seul.

### 35b.4 L'UI (D267)

« Envoyer » dans `EcrireAuMesh`, l'attente, les libellés, l'envoi incertain sans « Réessayer », la ligne de réglage dans l'écran des confirmations. Contre une route simulée ; ne dépend pas du schéma.
- *Révision 35b.4.* `envoyerEcriture`, `libelleEnvoi` et `envoiIncertain` dans `web/src/data/ecritures.ts`. **À aligner au 35b.3 :** le daemon remplit `envoi: {code, id?, open_obligations, status?}` (code `succes` en cas de réussite) sur une demande `mesh.ecrire`, à côté de `resultat`, qui reste une chaîne. Le web ne sait pas d'avance si le proxy est configuré : il le déduit du premier 409 `proxy_absent`. 12 lignes existantes modifiées (dont `AttenteConfirmation` et l'e2e du 35). Gate 2778.

### 35b.5 Le vrai proxy, l'e2e et la fiche de recette

Après le build mergé. Un test contre le vrai `swarph proxy serve` avec une fausse gateway (L4), l'e2e sur le faux proxy, et la fiche `docs/recette-chantier-35bis-envoi.md` : une note, un DM et un post réels, chacun confirmé au téléphone, puis relus dans le fil ; un envoi avec le proxy arrêté (rien ne part) ; aucune trace du texte dans le journal.

### 35b.6 Correctif : la confirmation toujours exigée (revue du lab #5036)

`mesh.ecrire` entre dans les actions toujours confirmées ; porte désarmée → 409 `confirmation_requise`, rien envoyé ; plus d'exécution directe.
- *Révision 35b.6 (correctif de sécurité, revue du lab #1551 / #5036, approuvé par Julien le 2026-11-10).* **D265 révisée :** `mesh.ecrire` appartient aux actions toujours confirmées ; son réglage n'est pas modifiable, et une ancienne valeur à 0 en base ne dispense jamais de la confirmation du téléphone. **D266 révisée :** `ecrire/envoyer` crée une demande de confirmation, ou refuse en 409 `confirmation_requise` avant `preparer` si la porte est désarmée ; il n'existe plus de chemin d'exécution directe. Ceci revient sur la reco Q1 (« tu peux couper la première »). Pas de migration : `exige` et `lire` ignorent la valeur stockée pour ces actions. 47 lignes existantes modifiées. Gate 2809 (échecs connus hors CI : install, update-check).

## 6. Pièges

- **Un envoi incertain n'est pas un échec.** Ne jamais le présenter comme « rien n'est parti », ni proposer de le refaire sans relire.
- **Le texte vit dans la demande signée** jusqu'à sa consommation (15 min au plus, D223). Il est déjà nettoyé, mais il ne doit sortir ni dans le journal ni dans un événement.
- **Pas de repli.** Aucun chemin ne doit retomber sur `swarph … say/send/post` en sous-processus, même en erreur.
- **Le schéma est publié (PR 702).** Les noms d'arguments viennent de lui seul, jamais du CLI.

## 7. Fini quand

- La recette des écritures sur le Mac attend #1539 (a) : le proxy du Mac est en lecture seule par configuration (DM 94977). Le test contre le vrai `swarph proxy serve` (`npm run test:vrai-proxy`, avec `AID_SWARPH_PROXY_PYTHON`) tient lieu de preuve d'intégration d'ici là (L4).

- 35b.2 à 35b.5 sont commités, avec `npm run gate` et `npm run e2e` verts.
- La CI est verte, le lab a validé, la recette de Julien est faite.
