# Mesure de Tailscale Serve (chantier 31, point 31.2)

Point 31.2 du plan `docs/chantiers/31-mode-host.md`, exigé par le lab (M3, DM 91348) avant tout code d'identité. Le résultat tranche **D179** : l'identité Tailscale est-elle exigée, ou seulement affichée ? Il fixe aussi la source du plafond d'appairage (D176).

**Ce n'est pas une recette sur le vrai mesh.** Aucun pair ni gateway swarph n'y prend part : la porte 0.b ne s'y applique pas.

## Avant de commencer

- La mesure se fait **sur le Mac de Julien, sur sa décision**. Elle change sa config Tailscale le temps de la mesure : un service Serve sur le port 443 du Mac.
- Rien ne tourne déjà sur ce service. `tailscale serve status` est vide avant de commencer. Sinon, s'arrêter et le noter.
- HTTPS est activé dans la console Tailscale (question 0 de la spec). Sinon, Serve refuse `--https`, et il faut le noter.
- La sonde (`scripts/sonde-serve.mjs`) écoute sur `127.0.0.1:4899`. Elle renvoie à celui qui l'appelle, et à lui seul, `Host`, les en-têtes d'adresse et les `Tailscale-*`, valeurs comprises. Des autres en-têtes, elle ne renvoie que le nom. Elle ne journalise rien.
- Aucun nom d'hôte du tailnet, aucune adresse IP du tailnet ni aucun login ne se colle dans cette fiche, dans un fil ou dans un DM. On note **la forme** (« le nom `.ts.net` du Mac », « le login de Julien », « une IP 100.x »), jamais la valeur.

## Procédure

1. Dans un terminal du Mac, depuis le dépôt :
   `node scripts/sonde-serve.mjs`
2. Dans un second terminal :
   `tailscale serve --bg --https=443 http://127.0.0.1:4899`
3. **Depuis le téléphone** (un nœud d'utilisateur), dans le navigateur, sur `https://<nom du Mac>/` :
   - **A.** une requête simple : noter le JSON affiché ;
   - **B.** une requête qui pose ses propres en-têtes. Le navigateur ne le permet pas : la faire depuis un autre ordinateur du tailnet, ou depuis le téléphone avec un client HTTP qui sait poser des en-têtes :
     `curl -s https://<nom du Mac>/ -H 'Tailscale-User-Login: forge@example' -H 'Tailscale-User-Name: forge' -H 'X-Forwarded-For: 203.0.113.9'`
4. **Depuis un nœud taggé**, s'il y en a un sur le tailnet (un serveur avec `tag:…`) : les mêmes requêtes A et B. S'il n'y en a pas, le noter.
5. **Depuis le Mac lui-même**, la requête B sur `https://<nom du Mac>/`.
6. **La forme de `tailscale serve status --json`**, pendant que Serve tourne : noter les clés (`TCP`, `Web`, `Handlers`, `Proxy`, `AllowFunnel`, ou d'autres), en remplaçant le nom du Mac par `<nom>`. Le daemon (31.3, `parseServe`) suppose cette forme, celle de la `ServeConfig` de Tailscale. Elle n'a pas encore été vue sur un vrai binaire.
7. À la fin, **obligatoire** (lab, DM 91366) :
   - `tailscale serve reset` ;
   - `tailscale serve status`, qui doit être vide ;
   - arrêter la sonde (Ctrl-C).

   Sinon, la sonde, qui renvoie les en-têtes, reste joignable sur le tailnet.

## Résultats

Date : _à noter_. Version de Tailscale sur le Mac (`tailscale version`) : _à noter_. Version sur le téléphone : _à noter_.

| Requête | `host` reçu | `tailscale-user-login` | `tailscale-user-name` | `x-forwarded-for` | Autres en-têtes ajoutés par Serve |
|---|---|---|---|---|---|
| A, téléphone | _à noter_ | _présent ? valeur = le login de Julien ?_ | _à noter_ | _à noter_ | _à noter_ |
| B, téléphone (en-têtes forgés) | _à noter_ | _le login de Julien, ou `forge@example` ?_ | _à noter_ | _`203.0.113.9` passé, remplacé, ou les deux ?_ | _à noter_ |
| A, nœud taggé | _à noter_ | _absent ?_ | _à noter_ | _à noter_ | _à noter_ |
| B, nœud taggé (en-têtes forgés) | _à noter_ | _**absent, ou `forge@example` ?**_ | _à noter_ | _à noter_ | _à noter_ |
| B, depuis le Mac | _à noter_ | _à noter_ | _à noter_ | _à noter_ | _à noter_ |

- [ ] `tailscale serve reset` fait, `tailscale serve status` vide ensuite (_heure_)
- [ ] Sonde arrêtée

## Ce que le résultat décide (D179)

- **Si Serve remplace `Tailscale-User-Login` dans tous les cas**, ou le retire quand il ne le pose pas, y compris en B depuis un nœud taggé, c'est-à-dire si `forge@example` n'apparaît jamais : l'identité est exigée égale au compte du Mac, à chaque requête d'un appareil qui l'a fournie à l'appairage.
- **Si `forge@example` apparaît dans une seule ligne** : l'identité n'est qu'affichée à l'appairage, marquée « non vérifiable », et jamais exigée. Le plan et la spec sont révisés, et le lab prévenu.
- **La source du plafond d'appairage** : c'est l'en-tête d'adresse que Serve pose lui-même, s'il remplace celui du client. Si le client peut l'imposer, le plafond devient global (5 réclamations par minute en tout).
- **`host`** : noter s'il vaut le nom `.ts.net` ou `127.0.0.1:4899`. Le port des appareils (D171) n'en dépend pas, mais son contrôle de `Host` (421) en dépend. Si Serve réécrit `Host` en `127.0.0.1:<port>`, ce contrôle accepte cette valeur sur ce port seulement, et le plan le dit.

Forme de `serve status --json` : _à noter (clés seulement)_ ; conforme à `parseServe` : _oui / non_

Constat et décision : _à remplir_
