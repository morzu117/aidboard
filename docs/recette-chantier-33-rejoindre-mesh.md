# Recette du chantier 33 — Rejoindre un mesh

**Risque accepté (Q1, décision de Julien).** Le jeton de cell est un fichier
en 0600 appartenant à l’utilisateur. Tout agent lancé sous le même utilisateur
peut le lire. Le mode `auto` ne change pas.

Cocher après observation sur une instance de recette. Ne recopier aucune
identité, adresse ni jeton réel dans le compte rendu. Les exemples utilisent
`peer-a`, `peer-b`, `principal`, `perso` et `https://aid-e2e.ts.net`.

## Avec le faux `swarph`

Lancer `npm run build`, puis
`env -u SWARPH_SELF -u MESH_GATEWAY_URL CI=1 mise exec node@22 -- npm run e2e -- e2e/rejoindre-mesh.spec.ts`.
Pour observer le navigateur, retirer `CI=1` et ajouter `--headed` à la commande
Playwright. Le scénario utilise des dossiers temporaires et des faux binaires,
sans contacter de gateway. Les issues sont pilotées par un fichier local.

- [ ] Depuis Machines, ouvrir « Rejoindre un mesh » et observer les trois champs.
      Le code apparaît avec un compte à rebours qui diminue et la commande
      d’approbation à copier, dont les paramètres opérateur restent à remplir.
- [ ] Après approbation simulée, lire « Cell inscrite, pas encore ratifiée »,
      les quatre questions, le modèle de réponses, la commande d’envoi et
      « Redémarre le daemon ». La boîte marche ; le board attend la ratification.
- [ ] Le test vérifie `meshes.perso`, le gateway normalisé, le faux jeton en
      0600 et son absence de la page, des réponses JSON observées et des journaux.
- [ ] Refus et expiration ont chacun leur message ; la config reste identique.
- [ ] Annuler pendant l’attente : le message et la commande de refus à copier
      reprennent le code. Aucune entrée n’est ajoutée à la config.
- [ ] « Oublier » retire `perso`, conserve `principal` et rappelle que le jeton
      existe toujours et que sa révocation dépend de l’opérateur.

## Avec un vrai gateway

À réaliser avec le lab ou sur le mesh de Julien, sur une instance de recette,
avec swarph-cli 0.80.0 ou plus et un opérateur disponible. Utiliser un nom de
cell neuf et un nom local de mesh libre ; les valeurs ci-dessus sont seulement
des exemples. Ne jamais copier le contenu du jeton dans A-I-D.

- [ ] Depuis Machines, saisir le gateway convenu, la nouvelle cell et `perso`.
      Observer le code et son expiration ; transmettre la commande à l’opérateur.
- [ ] L’opérateur complète le témoin et son fichier de jeton opérateur, puis
      approuve. A-I-D n’exécute aucune commande d’approbation.
- [ ] Observer le succès non ratifié, les quatre questions et l’invitation
      à redémarrer. Vérifier l’entrée de config et les droits 0600 du jeton,
      sans afficher son contenu.
- [ ] Rédiger les réponses dans ses propres mots : `Handshake for <cell>`,
      puis chaque question et sa réponse. Envoyer avec la commande proposée,
      en `--kind status`, au témoin convenu. A-I-D ne répond ni n’envoie à sa place.
- [ ] Redémarrer le daemon pour activer le mesh. Avant que le témoin ne ratifie,
      vérifier réellement la boîte avec un message de recette adressé à la cell :
      elle fonctionne. Le board reste vide et les envois au groupe ALL ne sont
      pas visibles (L4). Coordonner ce délai avec le témoin.
- [ ] Après ratification par le témoin, vérifier les droits et les cartes
      attendus sur le board, selon les autorisations de la cell.
- [ ] Demander un autre code avec une autre cell neuve et un autre nom local.
      L’opérateur le refuse : message de refus, aucune nouvelle entrée de config.
- [ ] Sur le mesh de recette autre que `principal`, cliquer « Oublier ».
      L’entrée disparaît de la config ; le jeton et le fichier d’inscription
      restent présents. Lire le rappel et demander à l’opérateur la révocation
      si la cell de recette doit être retirée du gateway.

## Essais du lab (15 novembre 2026)

Le lab a fait deux essais avec le vrai `swarph join` (swarph-cli 0.81.0) contre le gateway de lab, sur son bac à sable. Le code d'A-I-D était celui de 455cefc, appelé par un petit script, hors de l'écran et sans la route. Le commander avait donné son accord. Ces essais ne remplacent pas la recette ci-dessus.

- **Expiration.** L'état passe à `en-attente`, avec le code lu sur la vraie ligne `Code:`. Personne n'approuve. Au bout de 15 minutes, l'état devient `expire`. Il ne reste ni réservation dans `.config/swarph`, ni `rejoindre.json`, et aucun peer n'est inscrit.
- **Approbation.** L'état passe à `en-attente`, puis le commander approuve avec le témoin du lab. L'état devient `approuve`, avec le témoin lu sur la vraie sortie. Le jeton et `join.json` sont en 0600, vus sans être lus, et `rejoindre.json` est effacé. Le peer est inscrit, non ratifié. Le commander révoque ce peer de test.
- **Non couvert par ces essais :** l'écriture de `config.yaml`. Le script n'appelait pas la route, qui fait cette écriture. Elle reste couverte par l'e2e.

Constats avec le faux : __________

Constats avec le vrai gateway : __________

- [ ] Recette observée et accord explicite pour le merge.
