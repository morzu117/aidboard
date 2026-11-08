# Recette confirmations (chantier 34)

Pour Julien, avec le PDA du chantier 43 déjà déployé et une instance de recette
isolée. Les cases restent à remplir sur les vrais téléphones. Utiliser un dépôt
et des PR jetables. Aucun résultat ci-dessous n'est une validation déjà obtenue.
Les noms `aid-e2e.ts.net`, `relais.example.com` et l'adresse `192.0.2.10` sont
seulement des exemples ; garder les valeurs réelles hors de cette fiche.

## Préparer

- [ ] Noter la révision, les versions Node et les versions iOS/Android, sans
  identifiant personnel. Refaire sous Node 22 puis Node 24.
- [ ] Vérifier le canal du 43 et le relais. Partir d'une installation de recette
  jamais armée, avant l'activation de sa première passkey PDA.
- [ ] Préparer plusieurs PR jetables avec une tête connue et une forge accessible.
  Ne pas utiliser un projet de production pour ces essais.

## Parcours réel

- [ ] Avant l'armement, vérifier « Confirmations non armées ». Sur Livraison,
  « Autoriser le merge », puis valider : le merge part directement.
  Constat : _à remplir_.
- [ ] Enregistrer le premier téléphone PDA. Comparer son empreinte à celle du Mac,
  puis accepter l'activation sur le Mac. L'armement arrive à cette activation.
  Vérifier « Premier appareil activé sans confirmation » et l'état armé.
  Ne pas recopier l'empreinte. Constat : _à remplir_.
- [ ] Sur une autre PR, autoriser le merge. Le Mac attend et propose Annuler.
  Sur le téléphone, lire le résumé et les paramètres, retaper le numéro et
  confirmer avec la passkey. Le Mac affiche « Exécutée ». Vérifier la fusion
  de la tête annoncée sur la forge. Constat : _à remplir_.
- [ ] Demander un merge, puis pousser un nouveau commit avant de répondre.
  Confirmer l'ancienne demande : « Périmée », aucune fusion de la nouvelle tête.
  Constat : _à remplir_.
- [ ] Demander un merge et cliquer Annuler sur le Mac. La demande disparaît de
  la file ; actualiser le téléphone : elle n'est plus confirmable.
  Constat : _à remplir_.
- [ ] Demander l'accès d'un nouvel appareil. Sur le Mac, approuver l'appairage :
  un numéro s'affiche en gros. Le retaper sur le téléphone PDA actif et confirmer.
  Vérifier « Exécutée » et l'accès du nouvel appareil. Constat : _à remplir_.
- [ ] Refaire un appairage. Cette fois, saisir volontairement un autre numéro
  de quatre chiffres sur le téléphone et signer. Le Mac affiche « Annulée :
  mauvais numéro saisi sur le téléphone », aussi dans les dernières demandes.
  L'appareil n'obtient aucun accès. Ne pas noter les numéros.
  Constat : _à remplir_.
- [ ] Dans Confirmations, couper Merge : une demande et un numéro apparaissent.
  Confirmer sur le téléphone : l'interrupteur se coupe. Le rallumer : c'est
  immédiat, sans nouvelle demande. Constat : _à remplir_.
- [ ] Avec le téléphone actif, cliquer Désarmer et taper « DÉSARMER ». Confirmer
  la demande avec le numéro du Mac. Vérifier le bandeau de désarmement, puis
  cliquer Réarmer : c'est immédiat, sans demande. Constat : _à remplir_.
- [ ] Activer un second téléphone PDA en confirmant avec le premier. Le second
  téléphone est le secours. Vérifier la disparition du bandeau d'amorçage et
  sa capacité à confirmer après révocation du premier. Constat : _à remplir_.
- [ ] Révoquer le dernier téléphone actif. Demander un merge : refus
  `confirmation_impossible`, « Allume le PDA et active un téléphone pour cette
  action ». La révocation n'a pas désarmé les confirmations.
  Constat : _à remplir_.
- [ ] Refaire l'amorçage depuis l'UI du Mac : comparer l'empreinte du nouveau
  téléphone et l'activer. Une nouvelle demande de merge peut être confirmée.
  Constat : _à remplir_.
- [ ] Arrêter les instances de recette et supprimer leurs ressources temporaires.
  Constat : _à remplir_.

## Couverture automatique et limites

`e2e/confirmations.spec.ts` utilise le daemon construit, le relais local du 43,
les frontaux HTTPS simulés, la passkey virtuelle Chromium et la forge factice.
Il couvre le merge direct puis confirmé, la péremption, l'appairage avec numéro
correct ou faux signé, l'annulation, le réglage, le désarmement, le réarmement
et le refus après révocation. Aucun vrai relais, forge ou Tailscale n'est appelé.
Les tests de frontière restent inchangés. Les vraies passkeys et les conditions
réseau des téléphones doivent être validées par le parcours ci-dessus.

## Vérifications du point 34.9

- Node 22.23.3 : typecheck, ESLint, Prettier et build passent.
- Les 18 tests web des confirmations passent, dont le motif D234 vérifié dans
  l'attente et les dernières demandes.
- Gate complet avec `TMPDIR=/var/tmp/aid-tmp-34.9` : 2 465 tests passent,
  2 sont ignorés et 2 échouent déjà sur la base HEAD sans le diff, vérifié sur
  une archive : `test/install.test.ts:37`, `expected 'repo' to be 'inconnu'` ;
  `test/update-check.test.ts:13`, `expected '/var/tmp/aid-tmp-34.9' to be null`.
  Le `.git` protégé de l'environnement affecte leur détection du dépôt. Aucun
  test exclu ou modifié pour contourner ces échecs.
- `npm run e2e` en entier : 117 tests passent, aucun sauté.
- Le parcours e2e confirmations passe ; la tête déplacée est relue par l'UI
  avant la réponse signée. Les données de préparation du sujet sont locales.
- Deux fichiers créés, trois complétés : aucune ligne existante remplacée ou
  supprimée, 27 lignes ajoutées aux fichiers existants. Aucune dépendance
  ajoutée, aucun fichier de frontière modifié, aucun commit ni push.
- Index structurel et gbrain absents : lecture directe, sans rayon d'impact
  établi par l'index ni handoff en mémoire. Ce bilan sert de handoff local.
- Écart au texte initial du plan : le brief final demande les cas merge et
  host ; le push confirmé n'est pas ajouté à l'e2e et reste testé au 34.5.

## Retour au lab

Renvoyer les cases et leurs résultats, les versions et la révision testée,
les écarts observés et les étapes pour les reproduire. Envoyer seulement des
résultats expurgés : sans numéro, sans empreinte et sans jeton ; aucun cookie,
login, hôte, adresse réelle ni journal brut.
