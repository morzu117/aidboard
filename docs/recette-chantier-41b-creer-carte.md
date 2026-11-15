# Recette de la création de carte (chantier 41 b)

Point 41b.5, sur un A-I-D relié à un vrai proxy en 0.82.0. Les cases se cochent sur place. Les relevés privés restent en local : cette fiche ne reçoit ni configuration, ni contenu réel, ni adresse, ni nom de projet réel. `peer-a`, `owner-a/depot-a#7` et `#1234` sont des exemples à remplacer en local.

**Cette recette crée une vraie carte.** Elle se fait sur un board de bac à sable, avec l'accord du commander, dans un projet où la cell de test a le droit d'écrire.

Version du proxy : ____________________ Projet choisi (id seul) : ____________________

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

- [ ] Vérifier que le proxy de la cell répond en 0.82.0 au moins, et qu'il n'est pas en lecture seule. Noter la version ci-dessus.
- [ ] Lire le menu du projet choisi, pour savoir quelles obligations obligatoires la carte ouvrira. Prévenir les détenteurs possibles si besoin. A-I-D ne les retirera pas.
- [ ] Choisir un sujet Swairm de test sans carte, visible dans « Sujets Swairm sans carte ». Relever en local sa ligne Swairm et l'heure de début.

## Création

- [ ] Cliquer « Créer la carte ». L'aperçu reste impossible tant qu'aucun projet n'est choisi.
- [ ] Choisir le projet. Garder ou corriger le titre, puis ajouter un texte neutre facultatif. La ligne Swairm n'est pas modifiable.
- [ ] Lire l'aperçu. Il montre les lignes « Titre », « Projet : <nom> (#<id>) » et « Sujet », le bandeau du mesh, et l'avertissement sur les obligations.
- [ ] Confirmer sur le téléphone. La demande affiche le résumé court et les trois lignes, sans aucun champ interne.
- [ ] L'écran affiche le message de création et l'id de la carte. À la lecture suivante, le sujet quitte la liste « sans carte » et pointe vers la nouvelle carte.
- [ ] Relire la carte avec le CLI de la cell : le corps commence par la ligne Swairm. Les obligations ouvertes sont celles du menu, sans détenteur.

## Doublons

- [ ] Recharger la page, puis vérifier que le sujet n'est plus proposé à la création.
- [ ] Si un second sujet de test peut recevoir une carte à la main dans un autre projet : la créer à la main, puis tenter « Créer la carte » depuis A-I-D. La confirmation n'envoie rien, et l'écran dit « Une carte porte déjà ce sujet ». Sinon, noter « non exercé ».
- [ ] Les issues incertaines, avec le délai de grâce et la reprise au démarrage, ne se provoquent pas sur un vrai board. Elles sont couvertes par les tests. Ne pas couper le proxy en pleine création pour les essayer.

## Ce qui n'est pas parti

- [ ] Vérifier dans le board qu'une seule carte porte la ligne de test.
- [ ] Inspecter en local le journal du daemon. Aucun jeton n'y figure, et aucune commande CLI d'écriture n'a été lancée : la création ne passe que par le proxy. Ne recopier ici aucune ligne privée.

Après la recette : archiver ou retirer la carte de test selon les usages du bac à sable, et fermer ses obligations avec leurs détenteurs.

Constats et cases non exercées (sans contenu privé) : ____________________
