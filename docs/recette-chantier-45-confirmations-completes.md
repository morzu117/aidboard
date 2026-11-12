# Recette du chantier 45 — Confirmations complètes

Julien, sur son Mac et son téléphone. Cocher après observation ; ne recopier
aucune identité, adresse, donnée d’authentification ou erreur réelle dans le
compte rendu. Les noms `aid-e2e.ts.net`, `example.com` et `peer-a` sont des
exemples uniquement.

## Avant tout

- [ ] Sur une instance de recette, ouvrir « Machines », activer le PDA avec
      son relais, appairer le téléphone et activer sa passkey après comparaison
      des empreintes. Attendu : téléphone actif, confirmations armées.
- [ ] Garder le panneau du Mac et l’app PDA du téléphone ouverts. Choisir des
      actions sans conséquence sur les données de travail : couper puis
      rallumer la confirmation « Merge », et retirer un projet de recette
      vide, sans sujet actif. Attendu : aucun vrai merge ni écriture mesh.
      Ne jamais employer un projet de travail pour le retrait.

Constats : __________

## Les paramètres signés

- [ ] Sur le Mac, couper la confirmation « Merge ». Dans le panneau
      « Confirmations », repérer la demande ouverte. Attendu : « Paramètres
      signés » est replié. Le déplier : « Action : merge », « Actif : non ».
- [ ] Sur le téléphone, actualiser les demandes. Attendu : les mêmes paramètres
      sont visibles avant la signature. Pour cette demande « toujours », le
      numéro est visible uniquement sur le Mac ; le téléphone demande de le
      retaper sans le révéler.
- [ ] Retaper ce numéro et confirmer avec la passkey. Attendu : la demande
      passe sous « Réponses récentes », avec « En attente du résultat », puis
      « Exécutée » sans actualiser ni recharger. Garder l’app au premier plan
      pendant 45 s ; la relève du daemon puis les relectures à +20 s et +45 s
      rendent le résultat visible. Sur le Mac, retrouver la demande récente
      et déplier ses paramètres : ils sont identiques. Rallumer « Merge ».
- [ ] Ajouter un projet de recette vide dont la racine finit par
      `/recette-45/`, puis demander son retrait. Attendu : le volet du Mac
      montre toute la racine ; le téléphone montre seulement `recette-45`,
      sans la barre finale ni les répertoires parents. Refuser sur le téléphone
      pour conserver le projet. Attendu : aucun retrait.

Constats : __________

## Le numéro faux et l’annulation

- [ ] Couper de nouveau « Merge ». Sur le téléphone, saisir quatre chiffres
      différents du numéro affiché sur le Mac et confirmer avec la passkey.
      Attendu : « En attente du résultat », puis « Annulée : numéro faux »
      sans rechargement. Sur le Mac, le réglage reste activé.
- [ ] Refaire la demande. Retaper le bon numéro sur le téléphone et confirmer,
      puis cliquer immédiatement « Annuler » dans la demande ouverte du Mac,
      avant la relève du daemon (15 s). Attendu : annulation sur le Mac,
      puis « Annulée » sur le téléphone, sans changement du réglage.
      Si l’exécution a précédé le clic, noter la course et recommencer :
      une action déjà exécutée ne peut plus être annulée.

Constats : __________

## Un résultat perdu

- [ ] Observation sur une instance de recette : après un « oui », laisser le
      daemon publier le résultat, puis redémarrer le relais avant la relecture
      du téléphone. Garder la même page du téléphone ouverte : un rechargement
      efface sa mémoire des réponses récentes. Attendu : le Mac conserve le
      résultat ; le relais, en mémoire seulement, l’a perdu.
- [ ] Observation à 24 h, sans imposer cette attente à la recette : si aucun
      résultat n’est reçu, la réponse récente affiche « Résultat non reçu,
      à lire sur le Mac ». Revenir dans l’app pour déclencher une relève.
      Attendu : aucun échec inventé ; le résultat reste consultable sur le Mac.

Constats : __________

## Ce qui ne doit jamais apparaître sur le téléphone

- [ ] Examiner les réponses récentes. Attendu : aucun numéro, aucun texte
      d’erreur du serveur, aucun détail brut du gateway. Les résultats sont
      des libellés locaux et des codes fermés. Pour une issue incertaine,
      « Issue incertaine, à vérifier sur le Mac » impose de vérifier sur le
      Mac avant de réessayer une écriture.

Constats : __________

## Ce que l’e2e couvre déjà

Le daemon construit et signe les demandes et les résultats ; un relais local
les transporte et une passkey virtuelle signe les réponses. Aucun service
extérieur n’est utilisé. Le test vérifie le volet replié puis déplié, les
paramètres et l’absence des clés de numéro dans la liste du Mac, puis les
transitions automatiques vers « Exécutée » et « Annulée : numéro faux ».
L’horloge du téléphone avance pour la relecture ; le daemon garde sa cadence
réelle. Le retrait, la course d’annulation et la perte du relais restent des
observations de cette recette.
