# Recette de la création de carte (chantier 41 b)

Point 41b.5, sur un A-I-D relié à un vrai proxy en 0.82.0. Les cases se cochent sur place. Les relevés privés restent en local : cette fiche ne reçoit ni configuration, ni contenu réel, ni adresse, ni nom de projet réel. `peer-a`, `owner-a/depot-a#7` et `#1234` sont des exemples à remplacer en local.

**Cette recette crée une vraie carte.** Elle se fait sur un board de bac à sable, avec l'accord du commander, dans un projet où la cell de test a le droit d'écrire.

Version du proxy : 0.83.0. Projet choisi (id seul) : #17.

**Faite par le lab le 2026-11-16 (DM 99179), sur son bac à sable, avec le go du commander (DM 99119).** A-I-D tournait sur main e0191c2, sous le compte de la cell. Le proxy tournait sous son propre compte, avec un jeton neuf que A-I-D n'a jamais lu. `whoami` répondait `per_peer_token`. Le téléphone était un appareil simulé, l'authentificateur WebAuthn virtuel de l'e2e, comme Julien l'a choisi (DM 99147). La recette prouve donc le proxy et le board réels, pas le téléphone. Elle suit le parcours de `e2e/creer-carte.spec.ts`, avec le vrai proxy à la place du faux.

## Couverture automatique

`e2e/creer-carte.spec.ts` joue deux parcours contre un faux proxy :
- un sujet sans carte, le choix du projet, l'aperçu, la confirmation, un seul `board.cards.create` avec `project`, `title` et `body`, puis le sujet relié à la lecture suivante ;
- une carte qui porte déjà la ligne dans un autre projet : la confirmation n'envoie rien, et l'écran le dit.

Les tests `test/creation-carte.test.ts` et `test/web/creation-carte.test.tsx` couvrent aussi :
- les issues certaines et incertaines ;
- le délai de grâce de 60 s ;
- la reprise au démarrage ;
- le code `verification_board` ;
- le bouton désactivé.

## Avant tout

- [x] Vérifier que le proxy de la cell répond en 0.82.0 au moins, et qu'il n'est pas en lecture seule. Noter la version ci-dessus.
  - Constat : 0.83.0, `read_only=false` au démarrage.
- [x] Lire le menu du projet choisi, pour savoir quelles obligations obligatoires la carte ouvrira. Prévenir les détenteurs possibles si besoin. A-I-D ne les retirera pas.
  - Constat : le menu par défaut. La carte ouvre `build`, `validate` et `plan-review`, sans détenteur.
- [x] Choisir un sujet Swairm de test sans carte, visible dans « Sujets Swairm sans carte ». Relever en local sa ligne Swairm et l'heure de début.
  - Constat : le sujet venait d'une sortie `swairm status --json` synthétique, au format `swairm-status/1`.

## Création

- [x] Cliquer « Créer la carte ». L'aperçu reste impossible tant qu'aucun projet n'est choisi.
- [x] Choisir le projet. Garder ou corriger le titre, puis ajouter un texte neutre facultatif. La ligne Swairm n'est pas modifiable.
- [x] Lire l'aperçu. Il montre les lignes « Titre », « Projet : <nom> (#<id>) » et « Sujet », le bandeau du mesh, et l'avertissement sur les obligations.
- [x] Confirmer sur le téléphone. La demande affiche le résumé court et les trois lignes, sans aucun champ interne.
- [x] L'écran affiche le message de création et l'id de la carte. À la lecture suivante, le sujet quitte la liste « sans carte » et pointe vers la nouvelle carte.
  - Constat : « Parti. » et « Carte : #<id> ». Le journal d'audit du proxy compte exactement un `board.cards.create`, en 200.
- [x] Relire la carte avec le CLI de la cell : le corps commence par la ligne Swairm. Les obligations ouvertes sont celles du menu, sans détenteur.
  - Constat : la carte est dans le projet #17, créée par la cell, avec les 3 obligations du menu.

## Doublons

- [x] Recharger la page, puis vérifier que le sujet n'est plus proposé à la création.
  - Constat : avec un daemon neuf, « Sujets Swairm sans carte (0) », la carte est reliée (« Swairm · planifié ») et aucun bouton « Créer la carte » n'est offert.
- [ ] Si un second sujet de test peut recevoir une carte à la main dans un autre projet : la créer à la main, puis tenter « Créer la carte » depuis A-I-D. La confirmation n'envoie rien, et l'écran dit « Une carte porte déjà ce sujet ». Sinon, noter « non exercé ».
  - **Non exercé.** La cell de test ne lit que le projet #17 : elle ne verrait pas une carte posée dans un autre projet. Ce cas reste couvert par l'e2e.
- [ ] Les issues incertaines, avec le délai de grâce et la reprise au démarrage, ne se provoquent pas sur un vrai board. Elles sont couvertes par les tests. Ne pas couper le proxy en pleine création pour les essayer.
  - Non provoqué, comme prévu.

## Ce qui n'est pas parti

- [x] Vérifier dans le board qu'une seule carte porte la ligne de test.
- [x] Inspecter en local le journal du daemon. Aucun jeton n'y figure, et aucune commande CLI d'écriture n'a été lancée : la création ne passe que par le proxy. Ne recopier ici aucune ligne privée.
  - Constat : 0 occurrence de `peer_token`, `Bearer` ou `Authorization`, et aucune commande CLI d'écriture. Le proxy n'a vu que `whoami`, `board.projects.list`, `board.cards.list` et `board.cards.create`.

Après la recette : archiver ou retirer la carte de test selon les usages du bac à sable, et fermer ses obligations avec leurs détenteurs.

Après la recette, le lab a retiré les 3 obligations et rangé la carte en `parked`.

Constats et cases non exercées (sans contenu privé) :
- la carte posée à la main dans un autre projet n'a pas été exercée (voir plus haut) ;
- après la création, la boîte de dialogue montre deux lignes de statut, « Exécutée » et « Parti. ». Cela n'a gêné que le script du lab, mais l'écran dit deux fois la même chose : ce point passe au tri de l'audit des interfaces (chantier 56) ;
- l'en-tête du Board dit « Lecture seule, sous l'identité de la cell … ». C'est vrai pour la vue, mais l'écran de création, lui, écrit : à revoir aussi au tri du 56 ;
- la pastille « swarph introuvable » venait de la config du bac à sable, où le CLI swarph était le faux de l'e2e. En mode proxy, A-I-D n'en a pas besoin.
