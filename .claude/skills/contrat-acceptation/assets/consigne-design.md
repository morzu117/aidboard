# Consigne à coller au début d'une session de design A-I-D

Copier tout ce qui suit le trait dans la session de design, avant de décrire l'écran.

---

Ces maquettes seront relues par un programme, puis comparées à l'application nœud par nœud. En
plus du rendu visuel, respecte les règles suivantes. Elles ne changent rien à l'apparence.

**1. Une planche par état et par taille.**
Pour chaque écran, produis au minimum :

- les états `default`, `empty` (rien à afficher), `loading` (lecture en cours) et `error` ;
- chacun en `desktop` (1440 px) et en `phone` (390 px).

Si un écran a d'autres situations qui changent ce qu'on voit (lecture seule, fonction
indisponible), ajoute une planche par situation et nomme-la d'un mot (`lecture-seule`).

La racine de chaque planche porte trois attributs :
`data-screen="<ecran>" data-state="<etat>" data-viewport="<phone|tablet|desktop|wide>"`.
`<ecran>` est un mot en minuscules avec tirets (`machines`, `creer-carte`), le même sur toutes les
planches de l'écran.

**2. Un `data-node` sur tout ce qui porte du sens.**
Les zones, les éléments interactifs, les textes porteurs d'information, les messages d'état. Pas
les blocs de simple mise en page.

- Forme : `ecran.zone.element[.champ]`, minuscules, tirets entre les mots, points entre les
  niveaux. Exemple : `machines.entete.titre`.
- Un élément répété porte son identifiant : `machines.machine-{{m.id}}.nom`.
- Un nom est unique dans une planche.
- Un même élément garde **le même nom dans tous les états et à toutes les tailles**. Sur
  téléphone, ce qui n'a pas la place est masqué, pas retiré de la structure.

**3. Les intentions.**
Chaque bouton, lien, champ, onglet porte `data-action="objet.verbe"` (`carte.creer`,
`sujet.ouvrir`). Chaque texte qui vient d'une donnée porte `data-bind="objet.champ"`
(`machine.nom`).

**4. Les valeurs viennent des tokens.**
Couleurs, tailles de police, rayons : uniquement des valeurs présentes dans le fichier de tokens.
Si une valeur manque, ajoute le token et signale-le, plutôt que d'écrire une valeur isolée.

**5. Dire ce qui est décidé.**
Dans le brief qui accompagne les maquettes, étiquette chaque élément :

- **Spécifié** : décidé, à implémenter tel quel ;
- **Illustratif** : donnée ou libellé inventé pour la maquette ;
- **À confirmer** : proposition non validée.

Donne le texte exact des messages d'erreur et des états vides : il sera vérifié mot pour mot.

**6. Ce qu'il faut livrer.**
Les sources des planches, le brief, le fichier de tokens, et la liste des planches avec leur
écran, leur état et leur taille. Si l'outil ne permet pas de poser des attributs `data-…` sur les
éléments, donne à la place, dans le brief, un tableau par écran : nom du nœud, ce que c'est, états
où il apparaît, tailles où il est masqué.
