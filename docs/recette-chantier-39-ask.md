# Recette du chantier 39 — Demander des avis

Julien, sur le Mac, avec l’abonnement Claude. Utiliser un dépôt de test propre,
un dossier courant de swairm sans activité et aucune autre demande en cours.
Ne noter ici aucun secret, chemin personnel ou identité de machine.

## Avant tout

- [ ] Relever `swairm --version` : __________. Vérifier que `swairm ask --help`
      présente bien `ask`, N et les modèles.
- [ ] Relever `claude --version` : __________.
- [ ] Ouvrir `claude`, consulter `/status` et confirmer que la session du Mac est
      connectée sur l’abonnement Claude. Quitter la session. Ne pas recopier
      d’identifiant ou de jeton dans cette fiche.
- [ ] Ouvrir A-I-D, écran Swarph, avec swairm actif ; ouvrir « Demander N avis ».
- [ ] Vérifier le rappel : « Le texte part chez le fournisseur de Swairm.
      N’y mets ni secret ni contenu de carte. »

Constats : __________

## Une question refusée

- [ ] Avant l’essai, exécuter `ls -la ~/.swairm/asks/` et conserver la liste
      localement (un dossier absent est possible).
- [ ] Envoyer cette question contenant uniquement une **fausse** clé :
      « Cette fausse clé sk-ant-XXXXXXXXXXXXXXXXXXXXXXXX doit-elle être refusée ? »
- [ ] Vérifier le refus et son message expliquant la classe détectée.
- [ ] Vérifier que le message ne recopie pas la fausse clé.
- [ ] Exécuter de nouveau `ls -la ~/.swairm/asks/` : aucune archive ajoutée,
      aucun fichier modifié ; si le dossier était absent, il reste absent.

Constats : __________

## La vraie question : Q6

Question Q6 de Julien à remplir, sans secret ni contenu de carte :

> ________________________________________________________________
>
> ________________________________________________________________

Numéroter les sous-questions avec `1.`, `2.`, etc.

- [ ] Dans la boîte, choisir N = 3 et les modèles `sonnet` et `opus` seulement.
- [ ] Relever le plafond affiché avant envoi : __________ USD
      (attendu : 3 × 0,50 = 1,50 USD).
- [ ] Préparer les bornes et inventaires de la section « Aucun outil » avant
      de cliquer sur « Envoyer ».
- [ ] Envoyer Q6, attendre le tableau et noter l’identifiant de la demande : __________.
- [ ] Relever dans l’archive les coûts `avis[].cout_usd` : __________,
      __________, __________ USD. Chaque coût connu reste sous 0,50 USD ;
      signaler tout coût inconnu plutôt que le compter comme gratuit.
- [ ] Comparer le coût total de l’archive et du tableau au plafond :
      réel __________ USD / plafond __________ USD.
- [ ] Relever les modèles servis, dans les en-têtes et `avis[].modele_servi` :
      __________. Les distinguer des alias demandés.
- [ ] Lire les verdicts et déplier les justifications ; vérifier la colonne
      Accord en dernier et les lignes partagées en tête, s’il y en a.
- [ ] Changer le tri par numéro et vérifier l’ordre des sous-questions.
- [ ] Fermer le tableau, retrouver Q6 dans les dernières demandes et la rouvrir.

Constats : __________

## Aucun outil

Dans un terminal, définir deux chemins génériques en les remplaçant localement :

```sh
dossier_swairm='/chemin/vers/dossier-courant-swairm'
depot_test='/chemin/vers/depot-test'
controle=$(mktemp -d)
find "$dossier_swairm" -type f | LC_ALL=C sort > "$controle/swairm-avant"
find "$depot_test" -type f | LC_ALL=C sort > "$controle/depot-avant"
git -C "$depot_test" status --porcelain
touch "$controle/debut"
```

Après la fin de Q6, sans autre activité dans ces dossiers :

```sh
touch "$controle/fin"
find "$dossier_swairm" -type f | LC_ALL=C sort > "$controle/swairm-apres"
find "$depot_test" -type f | LC_ALL=C sort > "$controle/depot-apres"
diff "$controle/swairm-avant" "$controle/swairm-apres"
diff "$controle/depot-avant" "$controle/depot-apres"
find "$dossier_swairm" "$depot_test" -type f \
  -newer "$controle/debut" ! -newer "$controle/fin" -print
git -C "$depot_test" status --porcelain
find "${TMPDIR:-/tmp}" -type d -name 'swairm-avis-*' \
  -newer "$controle/debut" ! -newer "$controle/fin" -print
find "${TMPDIR:-/tmp}" -type d -name 'swairm-avis-*' -print
```

- [ ] Le dépôt de test était propre avant l’essai.
- [ ] Aucun fichier nouveau dans le dossier courant de swairm (premier `diff` vide).
- [ ] Aucun fichier nouveau dans le dépôt ouvert (second `diff` vide).
- [ ] Le `find` sur l’intervalle ne montre aucune écriture dans ces deux dossiers.
- [ ] `git status --porcelain` reste vide après la demande.
- [ ] Les dossiers temporaires `swairm-avis-*` de cet essai sont supprimés :
      le `find` sur l’intervalle ne rend rien. Le dernier `find`, sans borne,
      permet aussi de repérer un dossier résiduel dont la date aurait changé.

L’archive attendue dans `~/.swairm/asks/` est extérieure aux deux dossiers
surveillés. Ces contrôles observent le disque ; la coupure des outils est aussi
couverte par les tests du lanceur de swairm.

Constats : __________

## Annulation

- [ ] Vérifier avant l’essai qu’aucun autre `claude -p` ne tourne.
- [ ] Lancer une nouvelle demande puis cliquer sur « Annuler » pendant l’attente.
- [ ] Vérifier l’état « Annulé » dans A-I-D.
- [ ] Exécuter `pgrep -fl "claude -p"` : aucune ligne après l’annulation.

Constats : __________

## Archive

Remplacer l’identifiant ci-dessous par celui de Q6. Commandes `stat` du Mac :

```sh
stat -f '%Lp' ~/.swairm/asks
stat -f '%Lp' ~/.swairm/asks/IDENTIFIANT.json
```

- [ ] Le dossier est en 0700 (`700` affiché).
- [ ] Le fichier est en 0600 (`600` affiché).
- [ ] `swairm ask --show IDENTIFIANT --json` relit la demande sans lancer d’avis.

Constats : __________
