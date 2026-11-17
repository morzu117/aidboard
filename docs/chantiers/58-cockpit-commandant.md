# Chantier 58 : le cockpit, la file des demandes au commandant

| Champ | Valeur |
|---|---|
| État | **Révision 2, 17 novembre 2026.** La révision 2 suit le départ du build de la passerelle et les amendements A.1 et A.2 de l'annexe A. La révision 1 suivait la relecture du lab (DM 99675), et la révision 0 date du même jour. Julien a dit oui au cockpit : « ok pour le cockpit, mais après le 56 » le 16 novembre, puis « ok pour l'identifiant cockpit ». Le 56 est mergé (PR #188). Julien a donné le départ le 17 novembre. |
| Emplacement final | `docs/chantiers/58-cockpit-commandant.md` sur `main` |
| Base | `main`. |
| Contrat | La spec #1630 v2.1 du lab (corps de la carte, version 7), section 5 : « What A-I-D gets ». Le contrat sur le fil est l'annexe A (post 99673 de #1630) : les lignes JSON (A1), le corps de `decide` et ses erreurs (A2), l'en-tête cockpit (A3), et trois vecteurs du digest (A4). Elle est complétée par la révision A.1 (post 99682), son addendum (99685), A.2 (99689, PASS de drop #5675) et la note 99692. **Elle est contraignante** : l'accept de la ligne de build #5679 (gpt-ops, 07:56Z) la cite, avec la liste de contrôle du build (post 99702). La cell de gestion l'a lu sur la ligne elle-même. Elle a été relue par drop (PASS #5604) et par la cell de gestion (DM 99312 et 99332). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI code sur un brief tiré de ce plan. La cell de gestion relit le diff, regarde les captures, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Le chantier touche le mesh, un identifiant et le PDA. Il faut donc la CI verte, la relecture du lab sur le diff du daemon, et le oui de Julien. |
| Dépend de | Les étapes 1 et 2 de la spec #1630, côté passerelle : `summary`, `why`, `digest`, la lecture d'une ligne, `decided_by` et `decided_via`, puis l'identifiant cockpit. Julien a fixé la condition de départ du code : que l'accept du build de la passerelle cite l'annexe A. C'est le cas depuis le 17 novembre à 07:56Z (ordre du commandant à 07:54Z, ligne #5679). Le merge du chantier attend, lui, le merge de la passerelle. Qui tient le cockpit : voir la section 6, tranchée par Julien. |

## 1. Le constat

Le 16 novembre, le commandant a mené le mesh depuis un téléphone. Les demandes qui l'attendent sont dans la file de la passerelle (#1297) :

- les actions `merge_pr`, `release_finish`, puis `required_checks` ;
- les questions libres, de type `decision`.

Aujourd'hui, seul le Command Center de swarph-desktop les montre. A-I-D a déjà, de son côté :

- un téléphone appairé, le PDA ;
- une porte des confirmations signées (chantiers 34 et 45) ;
- le mode host, qui sert les écrans aux appareils.

Le lab a proposé qu'A-I-D devienne l'écran de cette file (DM 99256). Le commandant a tranché (16:47Z) : A-I-D **liste et montre** les demandes, et **répond aux questions**. Il **n'approuve aucune action**. L'approbation d'une action depuis le cockpit attend que la passerelle vérifie elle-même l'assertion WebAuthn (#1481 phase 2, après le #20).

## 2. Les décisions

| # | Décision | Source |
|---|---|---|
| **D347** | **L'identifiant cockpit.**<br>• **Ce qu'il est.** La passerelle émet un jeton opaque, que le commandant crée depuis sa session SSO. Ce n'est pas le jeton de cell. La passerelle l'accepte pour trois choses seulement : lister toutes les demandes, en lire une, et répondre à une question.<br>• **Où il vit.** Un fichier par mesh, dans le dossier d'A-I-D, à côté de `config.yaml` : `~/.aid/cockpit/<nom du mesh>.token` (ou sous `$AID_HOME`), en mode 0600, dans un dossier en 0700. A-I-D le lit lui-même, parce qu'il appelle la passerelle, au contraire du jeton de cell, que seul swarph lit. Il n'apparaît jamais dans `config.yaml`, ni dans un journal, un événement, une réponse HTTP ou une erreur. Son format est fixe : `swck_` suivi de 43 caractères base64url (A3). `secrets.ts` apprend ce préfixe, et A-I-D refuse à la saisie toute valeur d'une autre forme.<br>• **Sa saisie.** Seule la session SSO du commandant de la passerelle peut le créer, dans l'onglet Command de swarph-desktop (confirmé par le commandant, DM 99705 ; le bouton est un build séparé de swarph-desktop). Il est montré une fois, avec son `credential_id` (`ck_` suivi de 8 hex) et son `expires_at`, à 30 jours au plus. Le titulaire le colle dans Réglages swarph, sur le Mac seulement : la route n'est pas enregistrée sur le port des appareils. A-I-D l'écrit d'un coup (fichier temporaire, puis renommage, comme au 55). Il ne le relit jamais vers l'écran, qui montre seulement « configuré » et la date de saisie. Un bouton « Retirer » supprime le fichier.<br>• **Ses états, montrés à l'écran :** absent ; valide ; expiré (401 `cockpit_credential_expired`) ; révoqué (401 `cockpit_credential_revoked`) ; inconnu (401 `cockpit_credential_unknown`) ; refusé (tout autre 401 ou 403). Après un état expiré, révoqué ou inconnu, A-I-D arrête d'interroger la passerelle et dit quoi faire : « crée un nouvel identifiant dans le Command Center, puis colle-le ici ». | Julien, 16 novembre : « ok pour l'identifiant cockpit » ; spec #1630 v2.1, section 2. |
| **D348** | **La lecture de la file.**<br>• **Les appels.** Le daemon lit `GET /commander/requests?status=pending`, puis `GET /commander/requests/{id}` pour chaque ligne qu'il montre. Il le fait toutes les 30 s pendant qu'un écran du cockpit est ouvert, toutes les 5 min sinon, et une fois à chaque ouverture d'écran. Il appelle la passerelle directement, en HTTP, à l'URL `gateway` du mesh, avec l'identifiant cockpit en en-tête.<br>• **Le contrôle du digest.** Pour chaque ligne lue, le daemon recalcule le digest : SHA-256 de la sérialisation RFC 8785 (JCS) de `{"id", "type", "params"}`. Il contrôle aussi le `summary` : 12 lignes au plus, 120 caractères au plus par ligne, ni caractère de contrôle, ni bidi, ni largeur nulle. Si le digest diffère, ou si le `summary` sort de ces règles, A-I-D n'affiche ni le résumé ni le `why`. Il montre « Demande illisible : le digest ne correspond pas » avec l'id, et il ne propose aucune réponse. Les cinq vecteurs V1 à V5 (A4, A.1, addendum) entrent tels quels dans les tests.<br>• **Les copies hors digest (A.1, A.2 F1).** `question`, `options` et `head_sha` au premier niveau, et le `needs_sso` de la ligne, ne sont pas couverts par le digest. A-I-D les affiche depuis `params` seulement. Il refuse une ligne dont une copie diffère de `params`, une clé absente de `params` comptant comme `null`. Il refuse aussi une action dont `needs_sso` n'est pas vrai.<br>• **Les limites d'une question (A.1).** La question fait 360 caractères au plus, avec 0 à 6 options de 40 caractères au plus. Une ligne d'avant le build qui les dépasse se lit seulement (A.2 F4).<br>• **Les formats.** Les statuts sont ceux de l'A.1 : `pending`, `approved`, `rejected`, `answered`, `executed`, `failed`, `stale`, `withdrawn`. Les dates sont lues en RFC 3339, et jamais comparées comme des chaînes.<br>• **La notification.** Une demande nouvelle déclenche une notification push qui porte l'id seulement (#1230) : « Demande au commandant #<id> ». Ni le résumé, ni le type, ni le proposant. | Spec #1630 v2.1, sections 1 et 5. |
| **D349** | **Ce que l'écran montre.**<br>• **Une ligne de la liste :** l'id, le type, le proposant, l'âge, et les 16 premiers caractères hex du digest.<br>• **Le détail :** le `summary` sous le titre « Rendu par la passerelle », puis le `why`, à part, sous « Les mots du proposant ». Viennent ensuite le digest en 16 hex, et `decided_by` / `decided_via` quand la demande est close.<br>• **Une action** (`merge_pr`, `release_finish`, `required_checks`) se lit seulement, sans bouton de réponse. Le texte fixe dit, en français : « Approuve dans l'onglet Command de swarph-desktop : demande #<id>, digest <16 hex> ». Il n'y a pas de lien, et le texte est le même que swarph-desktop soit installé ou non.<br>• **Une question avec `needs_sso`** se lit seulement : « Cette question demande ta session SSO : réponds dans le Command Center. »<br>• **Les autres questions** ont un bouton par option, prise dans `params.options`. Une question sans option (`options` vide, permis aujourd'hui) a un champ libre : non vide, 1 000 caractères au plus, même règle de caractères que le `summary`. La passerelle accepte aussi un texte libre quand il y a des options (A2) ; A-I-D s'en tient alors à ses boutons.<br>• **Les deux formats de D342** (1280 × 800 et 390 × 844) sont servis sur le Mac et sur les appareils du mode host. La saisie de l'identifiant reste sur le Mac. | Spec #1630 v2.1, section 5, et F8. |
| **D350** | **Répondre à une question, par la porte des confirmations.**<br>• **L'action.** Une nouvelle action de la porte : `mesh.commandant.repondre`, de classe `toujours`. Le Mac et le téléphone ne répondent jamais sans une confirmation du PDA.<br>• **Les paramètres signés :** `{mesh, requestId, type: "decision", digest (64 hex), decision}`. Le texte de la question et les options sont signés avec eux, pour que le téléphone montre exactement ce à quoi il répond.<br>• **`preparer`** relit la ligne. Il refuse si elle n'est plus `pending`, si elle n'est pas une `decision`, si `needs_sso` est vrai, ou si son digest diffère. Il refuse aussi une réponse hors des options quand il y en a, et un texte libre vide, trop long ou hors de la règle de caractères.<br>• **`executer`**, après le oui du téléphone, relit la ligne encore une fois. Si elle a changé, il écrit « périmée » et n'envoie rien. Sinon, il envoie `POST /commander/requests/{id}/decide` avec l'identifiant cockpit et le corps `{"decision":"answer","answer":…,"digest":<64 hex>}` (A2). En cas de succès, la passerelle rend la ligne, et A-I-D y vérifie `decided_via=cockpit`. Le résultat signé (D305) dit « répondu », « périmée » ou « refusé par la passerelle », avec le code.<br>• **L'échéance.** Une confirmation expire après 15 min, comme les autres. La demande, elle, n'expire pas côté passerelle. | Spec #1630 v2.1, section 5 ; forme proposée par la cell de gestion (DM 99312). |
| **D351** | **Une réponse du cockpit ne vaut jamais un go.** A-I-D l'écrit à côté de chaque réponse envoyée : « Réponse du cockpit : elle ne vaut pas un go pour un réglage, une identité, un merge ou une release. » Aucun code d'A-I-D ne déclenche une action à partir d'une réponse du cockpit. | Spec #1630 v2.1, section 2, et F8. |
| **D352** | **Hors de ce chantier.** L'approbation d'une action depuis A-I-D, l'approbation à la création, les deux types locaux à la boîte (`cell_github_login`, `file_mode_tighten`) et les autorisations permanentes. Tous attendent le #20 et la phase 2 du #1481. A-I-D ne crée pas non plus de demande : la création reste réservée au jeton de pair. | Commandant, 16:47Z ; spec #1630 v2.1, « Cut from v1 ». |

## 3. Les points

### 58.1 Le plan

Ce document, relu par le lab avant tout code.

### 58.2 Le client de la file et l'identifiant (D347, D348)

Côté daemon, sans écran :

- **Le fichier de l'identifiant**, avec son écriture d'un coup, sa suppression et ses états.
- **Le client HTTP** de la file : la liste, une ligne, la réponse.
- **Le calcul JCS et le digest**, avec les vecteurs du lab et des cas faits à la main : clés désordonnées, nombres, échappements Unicode.
- **Le contrôle du `summary`**, avec un cas par règle refusée.
- **La lecture périodique** et la notification qui porte l'id seulement.
- **Les routes** `/api/commandant/*`. La route de l'identifiant n'existe que sur le port du Mac.

L'e2e et les tests jouent la passerelle avec un faux, dans `test/fixtures/`. Ce faux suit le JSON d'exemple du lab, champ pour champ. Les tests vérifient aussi qu'aucun journal, aucun événement et aucune réponse HTTP ne contient l'identifiant.

### 58.3 Les écrans et la réponse (D349, D350, D351)

- **L'écran** `/swarph/commandant`, avec la liste et le détail, dans Swarph, à côté des Demandes au mesh.
- **La saisie de l'identifiant** dans Réglages swarph.
- **L'action** `mesh.commandant.repondre`, de bout en bout : le Mac, le téléphone, le daemon, puis le faux de la passerelle.
- **La politique D342 au complet :**
  - chaque bouton est cliqué par un e2e ;
  - chaque refus a son cas : chacune des réponses d'erreur exactes de l'A2 et de l'A3 : 409 `digest_mismatch`, 409 `not_pending` (la demande a reçu une réponse ailleurs entre la lecture et l'envoi), 403 `needs_sso`, 403 `cockpit_not_allowed`, 404 `not_found`, 400 `bad_decision`, `bad_answer` et `digest_required`, 422 sur un champ requis absent, et 401 `cockpit_credential_unknown`, `_revoked` et `_expired`. L'ordre de priorité de l'A.1 est joué par le faux. S'y ajoutent la demande devenue périmée entre le oui et l'envoi, et une ligne au digest faux ;
  - les captures sont revues dans les deux formats ;
  - le garde de couverture (D345) et le détecteur visuel (D346) sont verts ;
  - l'inventaire gagne les nouveaux ids.

### 58.4 La vérification réelle

Elle a lieu sur la passerelle où Julien est le commandant (section 6). Elle attend donc le portage de la file dans la passerelle publique de swarph-cli (carte #1645). Elle se fait avec le lab, sur une vraie question créée par une cell :

1. Le commandant de la passerelle de la vérification crée l'identifiant. Son titulaire le colle dans A-I-D (voir la section 6).
2. La question apparaît, avec son digest. Le titulaire répond depuis le téléphone.
3. La passerelle enregistre `decided_via=cockpit`.
4. Le lab vérifie l'écart sur une action, sans bouton de réponse, et sur une question `needs_sso`, refusée.
5. Le commandant révoque l'identifiant, et A-I-D l'affiche.

## 4. Pièges

- **Le faux et le vrai.** Le faux de la passerelle suit l'exemple du lab. S'ils divergent, c'est le vrai qui gagne, et le faux est corrigé dans le même point.
- **JCS.** La bibliothèque standard de Node n'a pas de JCS. Les clés sont triées par unités UTF-16, et les nombres sont écrits comme `JSON.stringify` les écrit. Les clés de la passerelle sont en ASCII et ses nombres sont des entiers : `JSON.stringify` sur des clés triées suffit pour ces données. La cell de gestion l'a vérifié le 17 novembre : les cinq vecteurs V1 à V5 tombent juste en Node 22. Aucune normalisation Unicode : les chaînes sont hachées telles que reçues. Ils entrent tels quels dans les tests, et ils font foi.
- **Le jeton.** Le chemin du fichier peut apparaître dans un message, pas son contenu. La revue cherche son préfixe dans le diff, dans les journaux de l'e2e et dans les captures.
- **Le mode host.** Les appareils lisent la file et répondent par le PDA. Ils ne voient jamais la route de l'identifiant.
- **Aucun vrai nom** de cell, de dépôt ou d'hôte dans les fixtures (garde des noms neutres, 49 et 54).

## 5. Fini quand

- 58.2 et 58.3 sont mergés, avec la CI verte, la relecture du lab et le oui de Julien.
- La vérification réelle du 58.4 est faite et notée ici.

## 6. Qui tient le cockpit

Le lab l'a soulevée comme bloquante (DM 99675, point 4a).

**Le fait.** Seule la session SSO du commandant d'une passerelle (`META_EDGE_COMMANDER_SUB`) peut créer l'identifiant cockpit de cette passerelle. Sur le mesh du lab, le commandant n'est pas Julien.

**La conséquence.** Si Julien tenait le cockpit de ce mesh, il répondrait aux questions posées au commandant.

**Les options.** Le lab pose la question au commandant, et la cell de gestion la pose à Julien :

- (1) le commandant tient lui-même le cockpit A-I-D pour ce mesh ;
- (2) le cockpit ne sert que sur une passerelle dont Julien est le commandant, et le 58.4 s'y fait, sur un bac à sable ;
- (3) le commandant délègue à Julien, en connaissance de cause.

Le code du 58.2 et du 58.3 ne dépend pas de la réponse : il prend un identifiant par mesh, quel qu'en soit le titulaire. Le 58.4 en dépend.

**La décision de Julien (17 novembre) : l'option (2).** Le cockpit sert seulement sur une passerelle dont Julien est le commandant. Le 58.4 se fait sur une passerelle bac à sable, où il l'est. Aucune autorité n'est déléguée. Sur le mesh du lab, A-I-D ne tient pas d'identifiant cockpit.

**L'ordre de Julien, le même jour.** Aucun code du 58.2 ne part avant que l'accept du build de la passerelle cite l'annexe A.

**La voie du commandant (DM 99705, 07:57Z).** Il penche pour porter la file et le cockpit dans la passerelle **publique** de swarph-cli (carte #1645). Ce sera une spec d'abord, après le merge de #1630. Julien pourra y être commandant sans le SSO du lab : un émetteur configurable, ou une clé propre à l'instance, que la spec tranchera. Le 58.4 attend ce portage. Le 58.2 et le 58.3 avancent contre le faux.
