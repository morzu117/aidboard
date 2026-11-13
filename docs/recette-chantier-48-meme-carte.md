# Recette du chantier 48 — Même carte, deux états

Cocher après observation sur une instance de recette. Ne recopier aucune
identité ni erreur réelle dans le compte rendu. Utiliser les alias `principal`
et `perso`, et les noms de démonstration `peer-a` et `peer-b`.

## Préparer avec deux faux meshes

Lancer `npm run build`, puis `npm run e2e -- e2e/cartes-reliees.spec.ts`.
Le scénario prépare deux faux meshes indépendants, `principal` et `perso`,
avec une carte #101 chacun, aux étapes `idea` et `build`.

- [ ] Sur la fiche #101 de `principal`, ouvrir « Relier à une carte d’un autre
      mesh », choisir `perso`, saisir 101 : l’aperçu montre les deux titres,
      les deux meshes et les étapes, puis « Confirmer le lien » crée le groupe.
- [ ] « Même carte ailleurs » montre la carte de `perso` avec son étape,
      son responsable, ses obligations, son échéance et sa mise à jour.
      Son lien ouvre la bonne carte sur le bon mesh.
- [ ] Sur le board, « Cartes reliées » montre les deux états côte à côte et
      la pastille « écart ». Deux étapes identiques ne portent pas cette pastille.
- [ ] Après changement du seul `thread_uuid` sous le même numéro, attendre
      l’expiration du cache (60 s), puis recharger : « carte remplacée » apparaît,
      sans titre, étape, responsable, obligations, échéance ni mise à jour de
      la carte de remplacement. Aucun rattachement silencieux.
- [ ] Retirer ce membre : la confirmation nomme `perso #101`. Annuler conserve
      le groupe ; confirmer le supprime puisqu’il reste moins de deux membres.
      La section disparaît et la liste indique « Aucune carte reliée. ».
- [ ] Le scénario automatisé termine sans demande d’écriture sur les faux meshes.

## Refaire avec deux vrais meshes

Sur une instance de recette où A-I-D dispose d’une cell sur chacun des deux
meshes, les présenter sous les alias `principal` et `perso`. Choisir deux
cartes de recette déjà existantes qui suivent le même travail ; noter leurs
numéros sans recopier de données réelles dans le compte rendu.

- [ ] Refaire le lien par l’aperçu, puis comparer chaque état avec sa source.
      Ouvrir chaque lien et vérifier le mesh et le numéro de la fiche.
- [ ] Observer la pastille « écart » pour deux étapes différentes, et son absence
      pour deux étapes identiques. Les états ne se synchronisent pas.
- [ ] Vérifier le retrait avec annulation puis confirmation, en thème clair
      puis sombre. Aucun changement de carte ni de champ `links` sur les meshes.
- [ ] S’il existe une carte de recette remplacée sous le même numéro, observer
      « carte remplacée » après expiration du cache et retirer ce membre.
      Ne pas remplacer une carte réelle pour les besoins de cette recette.
- [ ] Avec un seul mesh actif : ni bouton de liaison ni liste sur le board.
      Un groupe existant reste visible sur la fiche, avec « mesh changé »
      pour son membre devenu inactif.

## Limites et accord

Les liens restent locaux à cette instance d’A-I-D. Rien n’est écrit sur un
mesh, y compris dans `links` : ni rapprochement automatique ni synchronisation.
L’export masqué (bloc 12) n’existe pas ; les meshes où A-I-D n’a pas de cell
ne sont pas couverts. Ces groupes ne sont pas exposés sur le serveur host,
le téléphone ou les appareils.

Constats avec deux faux meshes : __________

Constats avec deux vrais meshes : __________

- [ ] Recette observée et accord explicite pour le merge.
