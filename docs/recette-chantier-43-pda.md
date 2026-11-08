# Recette PDA (chantier 43)

Grille du point 43.10 de `docs/chantiers/43-pda.md`. Les cases sont à remplir
par la personne qui fait la recette, sur iPhone installé et Android.
Ne consigner aucun hôte, adresse, login, jeton, cookie ou clé privée réels.
Les noms ci-dessous sont exclusivement des exemples de documentation.

## Couverture automatique

`e2e/pda.spec.ts` utilise Chromium, un authentificateur virtuel CDP avec UV,
un daemon séparé et le CLI construit. Deux frontaux HTTPS locaux représentent
l'app et `relais.aid-e2e.example`. Le module `e2e/pda-fetch.mjs`, préchargé dans
le daemon du test uniquement, réécrit cette seule origine vers le relais local.
Aucun réglage de transport n'est ajouté au produit.

Le parcours vérifie l'enregistrement, la comparaison des empreintes, l'activation,
les essais confirmé et refusé, UV refusée, la révocation, la rotation et le cache.
Avec UV refusée, Chromium peut bloquer l'assertion avant son envoi : le test
vérifie alors que la demande reste ouverte puis expire, sans confirmation. Le
journal `pda.refus/presence` est vérifié si une assertion atteint le daemon.
Les tests de frontière `host-liste`, `host-masque` et `host-signal` restent inchangés.

## Déploiement du relais

- [ ] Instance de recette isolée : head et versions Node _à remplir_. Node 22
  requis ; refaire la recette sous Node 24.
- [ ] Sur un VPS de Julien, installer Node 22 et le CLI construit. Créer un
  utilisateur système dédié sans privilèges. Remplacer les chemins d'installation
  ci-dessous localement, sans reporter les valeurs réelles dans cette fiche.
- [ ] Sur le Mac, copier la **clé publique** du panneau PDA. Dans un fichier
  systemd local protégé, définir `CLE_PUBLIQUE_DAEMON` avec cette valeur.
  Ne jamais transférer la clé privée du daemon.

Exemple d'unité `/etc/systemd/system/aid-relais.service` :

```ini
[Unit]
Description=Relais PDA A-I-D
After=network.target

[Service]
User=aid-relais
EnvironmentFile=/etc/aid-relais.env
ExecStart=/usr/bin/node /opt/aid/dist/cli/aid.js relais --hote 127.0.0.1 --port 8787 --origine https://aid-e2e.ts.net --cle-daemon ${CLE_PUBLIQUE_DAEMON} --confiance-proxy
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Exemple Caddy, avec TLS automatique :

```caddyfile
relais.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

- [ ] Configurer le DNS du relais et ouvrir les ports publics 80 et 443 pour
  Caddy. Le port 8787 reste local. L'origine de l'app reste dans le tailnet :
  ne jamais l'exposer par Funnel ou par un nom public.
- [ ] `systemctl daemon-reload`, puis `systemctl enable --now aid-relais` ;
  valider et recharger Caddy. Vérifier les journaux de démarrage.
- [ ] `curl -sS -D /tmp/aid-relais-entetes -o /tmp/aid-relais-corps https://relais.example.com/` :
  statut **404**, `wc -c < /tmp/aid-relais-corps` donne **0**.
- [ ] Vérifier les en-têtes de sécurité du relais, notamment CSP, protection
  contre le reniflage de type et Cache-Control: no-store. Aucun code, page ou script
  n'est servi par le relais. Ne publier aucun journal brut.
- [ ] Sur le Mac, saisir `https://relais.example.com`, puis allumer le PDA.
  Vérifier l'origine autorisée exacte et l'absence d'authentification par cookie.
  Constat du déploiement : _à remplir_.

## Recette réelle

- [ ] 43.R.1 Appairer deux téléphones dans leur accès de 8 h, depuis le tailnet :
  iPhone **iOS 16.4 ou plus**, app installée et ouverte depuis son icône, puis
  Android Chrome. Noter modèles et versions, sans identifiant personnel.
  Sur chacun, ouvrir `/pda/enregistrer`, donner un nom, créer la passkey,
  comparer l'empreinte avec le Mac et vérifier que la confirmation « Activer »
  cite cette empreinte. Activer les deux appareils.
  Constat et versions : _à remplir_.
- [ ] 43.R.2 Couper Tailscale sur le premier téléphone, passer en **4G**.
  Envoyer un essai sur le Mac. Ouvrir Confirmations depuis l'app en cache :
  « Demande d'essai », sujet et numéro visibles. Retaper le numéro lu sur le
  téléphone, confirmer avec la passkey. Le Mac affiche « Confirmée ».
  Refaire en touchant « Refuser » : le Mac affiche « Refusée ».
  Constat pour chaque plateforme : _à remplir_.
- [ ] 43.R.3 Ouvrir une même demande sur les deux appareils avant de répondre.
  Répondre sur les deux à quelques secondes d'intervalle, avant le prochain
  sondage du daemon (15 s), pour déposer les deux réponses au relais. La première
  réponse valide l'emporte ; la seconde ne change pas le résultat et produit
  `pda.tardive` dans le journal du daemon. Si le relais a déjà retiré la demande,
  refaire avec une nouvelle demande et rapprocher les deux réponses.

  Constat : _à remplir_.
- [ ] 43.R.4 Téléphone verrouillé, rouvrir l'app puis confirmer : Face ID ou
  l'empreinte est exigé. Annuler l'authentification : aucune confirmation sur le
  Mac. Refaire sur iPhone et Android, avec leurs vraies passkeys.
  Constat : _à remplir_.
- [ ] 43.R.5 Révoquer le premier appareil sur le Mac. Envoyer un nouvel essai :
  téléphone refusé (401 et message, ou demande absente), jamais « Confirmée ».
  Le second appareil actif fonctionne toujours.
  Constat : _à remplir_.
- [ ] 43.R.6 Garder un téléphone actif ouvert hors du tailnet. Faire tourner
  la clé sur le Mac, remplacer la clé publique dans le fichier d'environnement
  du relais, puis `systemctl restart aid-relais`. Un nouvel essai est illisible
  sur le téléphone resté sur l'ancienne clé, sans demande affichée. Rejoindre
  le tailnet et recharger : la nouvelle demande devient lisible et confirmable.
  Constat avant et après mise à jour : _à remplir_.
- [ ] 43.R.7 Effacer les données du site sur un téléphone hors du tailnet.
  Impossible de répondre depuis ce cache perdu : refus fermé, aucune action
  ni confirmation. Revenir dans le tailnet et refaire l'enregistrement.
  Constat : _à remplir_.
- [ ] 43.R.8 Couper le PDA sur le Mac. Observer le journal du relais pendant
  plus de cinq minutes : plus aucune nouvelle requête du daemon, dépôt ou
  sondage. Distinguer les requêtes manuelles du téléphone et celles en transit.
  Constat et durée : _à remplir_.
- [ ] 43.R.9 Arrêter les instances de recette et retirer leurs services et
  configurations temporaires après les vérifications sous Node 22 puis 24.
  Constat : _à remplir_.

## Limites et résidus acceptés

- [ ] L'e2e ne prouve ni les vraies passkeys iOS/Android (compteur, UV), ni la
  synchronisation iCloud ou Google. Les passkeys synchronisées peuvent garder
  un compteur nul : la recette réelle et la validation du lab portent ces
  limites (DM 92443). Résultats par plateforme : _à remplir_.
- [ ] Le relais voit le **nom du sujet et l'heure des demandes**, même si son
  journal ne garde pas le sujet. Résidu constaté et accepté : _à remplir_.
- [ ] L'empreinte de **40 bits** aide à comparer les appareils ; elle n'est
  pas une barrière cryptographique. L'enregistrement dans le tailnet, depuis
  un appareil autorisé, reste la barrière (lab, DM 92447).
  Acceptation : _à remplir_.
- [ ] Le relais purge une réponse dès que le daemon l'a tirée. Si le daemon
  tombe entre ce tirage et la consommation de la demande, la réponse est
  perdue : il faut répondre à nouveau, ou la demande expire. Rien ne
  s'exécute sans réponse, donc l'échec est fermé (lab, DM 92510).
  Acceptation : _à remplir_.
- [ ] La CSP des appareils garde `style-src 'self' 'unsafe-inline'`. Ce n'est
  pas une faille ici, puisque l'écran du PDA n'affiche que du texte React.
  La retirer, quand les styles en ligne auront disparu, fermerait aussi
  l'exfiltration par CSS. Suivi recommandé par le lab (DM 92510).

## Vérifications du point 43.10

- Node 22.23.3 : typecheck, ESLint, Prettier et build passent.
- Les 106 tests ciblés PDA et frontière passent ; aucun fichier de frontière modifié.
- `npm run build`, puis `npm run e2e` en entier : **116 tests passent**, dont
  le nouveau parcours PDA. Rotation : illisible avec l'ancienne clé, visible
  après rechargement dans le tailnet. Frontal de l'app arrêté : coque servie
  depuis le cache et demande récupérée auprès du relais toujours joignable.
  Aucun cas sauté.
- UV refusée : Chromium bloque l'assertion avant l'envoi. Aucun événement
  `pda.refus/presence` ne peut alors être produit par le daemon. Le test vérifie
  la demande ouverte, jamais confirmée, puis son expiration réelle après cinq
  minutes. C'est l'écart au contrôle du journal demandé ; aucune assertion ni
  vérification n'est contournée.
- Gate complet avec `TMPDIR=/var/tmp/aid-tmp-43.10` : **2 318 tests passent,
  2 ignorés, 2 échecs préexistants**, reproduits sur une archive de HEAD sans
  ces trois fichiers : `test/install.test.ts:37`, `expected 'repo' to be 'inconnu'` ;
  `test/update-check.test.ts:13`, `expected '/var/tmp/aid-tmp-43.10' to be null`.
  Le `.git` protégé de l'environnement affecte la détection du dépôt. Aucun
  test exclu ni seuil modifié. Deux échecs de délai observés au premier lancement
  (`test/web/host.test.tsx` et `test/agents-pilotage.test.ts`) passent au rejeu
  séparé et dans le gate final.
- Trois fichiers créés, **zéro ligne existante modifiée**, aucune dépendance
  ajoutée. Daemon, relais et frontaux arrêtés. Aucun commit ni push, selon le brief.
- Index structurel et gbrain absents : lecture directe, sans rayon d'impact
  établi par l'index ni handoff en mémoire. Ce bilan tient lieu de handoff local.

La recette réelle reste à effectuer ; aucune case ci-dessus ne constitue une
validation déjà obtenue sur de vrais téléphones.
