#!/usr/bin/env node
// Valide des fiches de référence (design/references/*.json) et, avec --plan, la section
// « Contrat d'acceptation » d'un plan de chantier.
// Usage : node valider-fiche.mjs [--plan docs/chantiers/<n>-<slug>.md] [--strict] <fiche.json>…
// Sortie : erreurs (code 1), avertissements (code 0, ou 1 avec --strict). Aucune dépendance.
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const dire = (s = '') => process.stdout.write(`${s}\n`);
const alerter = (s = '') => process.stderr.write(`${s}\n`);

const argv = process.argv.slice(2);
let plan;
let strict = false;
const fiches = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--plan') plan = argv[++i];
  else if (argv[i] === '--strict') strict = true;
  else if (!argv[i].startsWith('-')) fiches.push(argv[i]);
}
if (argv.includes('--help') || argv.includes('-h') || (fiches.length === 0 && !plan)) {
  alerter('Usage : node valider-fiche.mjs [--plan <plan.md>] [--strict] <fiche.json> [...]');
  process.exit(2);
}

const erreurs = [];
const avertissements = [];
const err = (ou, msg) => erreurs.push(`${ou} : ${msg}`);
const avert = (ou, msg) => avertissements.push(`${ou} : ${msg}`);

const SOURCES = ['maquette-convention', 'export-dc', 'captures', 'brief', 'application', 'aucune'];
const PROVENANCES = ['specifie', 'existant', 'illustratif', 'a-confirmer'];
const TAILLES = { phone: 390, tablet: 834, desktop: 1440, wide: 1920 };
const NIVEAUX = {
  unitaire: /^test\/(?!web\/).+\.test\.ts$/,
  web: /^test\/web\/.+\.test\.tsx?$/,
  e2e: /^e2e\/.+\.spec\.ts$/,
  conformite: /^design\/references\/.+\.json$/,
  recette: /^docs\/recette.+\.md$/,
};
const ID_NOEUD =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:[a-z0-9]+|\{[^{}.]+\})(?:-(?:[a-z0-9]+|\{[^{}.]+\}))*)*$/;

const tousNoeuds = new Set();
const ficheDe = new Map(); // id de nœud -> { etats, tailles }
const ecransLus = new Set();
const inclusions = [];
const aPoser = [];
const aConfirmer = [];

function chercherToken(obj, chemin) {
  return chemin.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

for (const f of fiches) {
  let d;
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    err(f, `JSON illisible (${e.message})`);
    continue;
  }
  if (d.version !== 1) err(f, '`version` doit valoir 1');
  for (const c of ['ecran', 'titre', 'chantier']) if (!d[c]) err(f, `champ \`${c}\` manquant`);
  if (d.ecran && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.ecran))
    err(f, `\`ecran\` mal formé : ${d.ecran}`);

  const s = d.source ?? {};
  if (!SOURCES.includes(s.type))
    err(f, `\`source.type\` inconnu : ${s.type} (attendu : ${SOURCES.join(', ')})`);
  if (!Array.isArray(s.fichiers)) err(f, '`source.fichiers` doit être une liste');
  else {
    if (s.type !== 'aucune' && s.fichiers.length === 0)
      err(f, '`source.fichiers` vide alors que la source n’est pas `aucune`');
    s.fichiers
      .filter((p) => !existsSync(p))
      .forEach((p) => avert(f, `source absente de la machine : ${p}`));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.releve ?? ''))
    err(f, '`source.releve` doit être une date AAAA-MM-JJ');

  let tokens;
  if (d.tokens) {
    if (!existsSync(d.tokens)) err(f, `fichier de tokens introuvable : ${d.tokens}`);
    else tokens = JSON.parse(readFileSync(d.tokens, 'utf8'));
  }

  if (s.aussi !== undefined) {
    if (!Array.isArray(s.aussi)) err(f, '`source.aussi` doit être une liste');
    else
      s.aussi
        .filter((t) => !SOURCES.includes(t))
        .forEach((t) => err(f, `\`source.aussi\` : type inconnu ${t}`));
  }
  let css;
  if (d.variables_css) {
    if (!existsSync(d.variables_css))
      err(f, `feuille de variables introuvable : ${d.variables_css}`);
    else css = readFileSync(d.variables_css, 'utf8');
  }
  if (d.ecran) ecransLus.add(d.ecran);
  if (d.inclut !== undefined) {
    if (!Array.isArray(d.inclut)) err(f, '`inclut` doit être une liste de noms de fiches');
    else d.inclut.forEach((e) => inclusions.push({ f, e }));
  }

  const tailles = Object.keys(d.tailles ?? {});
  if (tailles.length === 0) err(f, '`tailles` vide');
  for (const t of tailles) {
    if (!(t in TAILLES)) err(f, `taille inconnue : ${t}`);
    else if (d.tailles[t] !== TAILLES[t])
      avert(f, `taille ${t} = ${d.tailles[t]} px, la convention dit ${TAILLES[t]}`);
  }

  const etats = Object.keys(d.etats ?? {});
  if (!etats.includes('default')) err(f, 'état `default` manquant');
  for (const e of etats) {
    const v = d.etats[e];
    if (!v?.mise_en_place) err(f, `état \`${e}\` sans \`mise_en_place\``);
    if (v?.provenance && !PROVENANCES.includes(v.provenance))
      err(f, `état \`${e}\` : provenance inconnue ${v.provenance}`);
    if (v?.provenance === 'a-confirmer') aConfirmer.push(`${f} · état ${e}`);
    if (v?.tailles !== undefined) {
      if (!Array.isArray(v.tailles)) err(f, `état \`${e}\` : \`tailles\` doit être une liste`);
      else
        v.tailles
          .filter((t) => !tailles.includes(t))
          .forEach((t) => err(f, `état \`${e}\` : taille \`${t}\` non déclarée`));
    }
  }

  const vus = new Set();
  if (!Array.isArray(d.noeuds) || d.noeuds.length === 0) err(f, '`noeuds` vide');
  for (const n of d.noeuds ?? []) {
    const ou = `${f} · ${n.id ?? '(sans id)'}`;
    if (!n.id) {
      err(ou, 'nœud sans `id`');
      continue;
    }
    if (vus.has(n.id)) err(ou, 'id en double');
    vus.add(n.id);
    tousNoeuds.add(n.id);
    ficheDe.set(n.id, { etats: d.etats ?? {}, tailles });
    if (n.nom_dans_app !== undefined && typeof n.nom_dans_app !== 'boolean')
      err(ou, '`nom_dans_app` doit valoir true ou false');
    if (n.nom_dans_app === false) aPoser.push(ou);
    if (n.texte !== undefined && typeof n.texte !== 'string') {
      if (n.texte === null || typeof n.texte !== 'object' || Array.isArray(n.texte))
        err(ou, '`texte` : une chaîne, ou un objet état → chaîne');
      else
        Object.keys(n.texte)
          .filter((x) => !etats.includes(x))
          .forEach((x) => err(ou, `\`texte\` cite l'état \`${x}\`, non déclaré`));
    }
    if (!ID_NOEUD.test(n.id))
      err(ou, 'id mal formé (minuscules, chiffres, tirets, points, {…} pour un indice)');
    if (d.ecran && n.id !== d.ecran && !n.id.startsWith(`${d.ecran}.`))
      err(ou, `ne commence pas par le préfixe \`${d.ecran}\``);
    if (!n.role) err(ou, '`role` manquant');
    if (!PROVENANCES.includes(n.provenance))
      err(ou, `provenance inconnue ou absente : ${n.provenance}`);
    if (n.provenance === 'a-confirmer') aConfirmer.push(ou);
    for (const [champ, admis] of [
      ['etats', etats],
      ['desactive_dans', etats],
      ['masque', tailles],
    ]) {
      if (n[champ] === undefined) continue;
      if (!Array.isArray(n[champ])) err(ou, `\`${champ}\` doit être une liste`);
      else
        n[champ]
          .filter((x) => !admis.includes(x))
          .forEach((x) => err(ou, `\`${champ}\` cite \`${x}\`, non déclaré dans la fiche`));
    }
    if (n.texte !== undefined && n.provenance === 'illustratif')
      avert(ou, '`texte` exact sur un nœud illustratif : le test vérifierait une donnée factice');
    const styles = Object.entries(n.styles ?? {});
    for (const [e, st] of Object.entries(n.styles_par_etat ?? {})) {
      if (!etats.includes(e)) err(ou, `\`styles_par_etat\` cite l'état \`${e}\`, non déclaré`);
      for (const [p, val] of Object.entries(st ?? {})) styles.push([`${p} (${e})`, val]);
    }
    for (const [prop, brut] of styles) {
      const v = typeof brut === 'object' && brut !== null ? brut : { valeur: brut };
      if (typeof v.valeur !== 'string' || v.valeur === '') {
        err(ou, `style \`${prop}\` sans valeur`);
        continue;
      }
      if (v.provenance && !PROVENANCES.includes(v.provenance))
        err(ou, `style \`${prop}\` : provenance inconnue ${v.provenance}`);
      if (v.provenance === 'a-confirmer') aConfirmer.push(`${ou} · style ${prop}`);
      if (v.valeur.startsWith('token:')) {
        if (!tokens)
          err(ou, `style \`${prop}\` renvoie à un token mais la fiche n'a pas de champ \`tokens\``);
        else if (chercherToken(tokens, v.valeur.slice(6)) === undefined)
          err(ou, `token introuvable : ${v.valeur.slice(6)}`);
      }
      if (v.valeur.startsWith('var:')) {
        const nom = v.valeur.slice(4);
        if (!/^--[a-zA-Z0-9-]+$/.test(nom))
          err(ou, `style \`${prop}\` : \`var:\` attend un nom de variable CSS (--nom)`);
        else if (!css)
          err(
            ou,
            `style \`${prop}\` renvoie à une variable CSS mais la fiche n'a pas de champ \`variables_css\``,
          );
        else if (!new RegExp(`${nom}\\s*:`).test(css))
          err(ou, `variable CSS introuvable dans ${d.variables_css} : ${nom}`);
      }
    }
  }
}

for (const { f, e } of inclusions)
  if (!ecransLus.has(e)) avert(f, `inclut la fiche \`${e}\`, non fournie au validateur`);

// ---------- Contrat dans le plan ----------
if (plan) {
  let md;
  try {
    md = readFileSync(plan, 'utf8');
  } catch (e) {
    err(plan, `illisible (${e.code ?? e.message})`);
  }
  if (md) {
    const lignes = md.split(/\r?\n/);
    const debut = lignes.findIndex((l) =>
      /^## Contrat d'acceptation\s*$/.test(l.replace('’', "'")),
    );
    if (debut < 0) err(plan, "section « ## Contrat d'acceptation » absente");
    else {
      let fin = lignes.findIndex((l, i) => i > debut && /^## /.test(l));
      if (fin < 0) fin = lignes.length;
      else avert(plan, 'le contrat n’est pas la dernière section du plan');
      const section = lignes.slice(debut, fin);
      const entete = section.findIndex((l) => /^\|\s*ID\s*\|/.test(l));
      const attendu = ['ID', 'Point', 'Critère', 'Niveau', 'Nœuds', 'Cadre', 'Test'];
      const cellules = (l) =>
        l
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim());
      if (entete < 0)
        err(plan, 'tableau du contrat introuvable (colonnes : ' + attendu.join(' | ') + ')');
      else {
        const cols = cellules(section[entete]);
        if (cols.join('|') !== attendu.join('|'))
          err(
            plan,
            `colonnes du contrat : « ${cols.join(' | ')} », attendu « ${attendu.join(' | ')} »`,
          );
        const ids = new Set();
        const pointsCouverts = new Set();
        const compte = {};
        for (const l of section.slice(entete + 2)) {
          if (!/^\s*\|/.test(l)) break;
          const c = cellules(l);
          const ou = `${plan} · ${c[0] || '(ligne sans ID)'}`;
          if (c.length !== attendu.length) {
            err(
              ou,
              `${c.length} colonnes au lieu de ${attendu.length} (un « | » dans une cellule s'écrit « \\| »)`,
            );
            continue;
          }
          const [id, point, critere, niveau, noeuds, cadre, test] = c;
          if (!/^[0-9a-z]+-C\d{2,}$/i.test(id)) err(ou, 'ID mal formé (attendu <chantier>-C<nn>)');
          if (ids.has(id)) err(ou, 'ID en double');
          ids.add(id);
          if (/^retiré\b/i.test(critere)) continue;
          pointsCouverts.add(point);
          if (!critere) err(ou, 'critère vide');
          if (!(niveau in NIVEAUX)) {
            err(ou, `niveau inconnu : ${niveau}`);
            continue;
          }
          compte[niveau] = (compte[niveau] ?? 0) + 1;
          const chemin = (test.match(/`([^`]+)`/) ?? [])[1];
          if (!chemin) err(ou, 'colonne Test : chemin entre accents graves attendu');
          else if (!NIVEAUX[niveau].test(chemin))
            err(ou, `le fichier \`${chemin}\` ne correspond pas au niveau ${niveau}`);
          if (niveau === 'recette' && !/non automatisable/i.test(critere))
            err(ou, 'critère de recette sans raison (« Non automatisable : … »)');
          const cites = [...noeuds.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
          if (cites.length === 0 && noeuds !== '—')
            err(ou, 'colonne Nœuds : identifiants entre accents graves, ou —');
          if (fiches.length)
            cites
              .filter((n) => !tousNoeuds.has(n))
              .forEach((n) => err(ou, `nœud \`${n}\` absent des fiches fournies`));
          if ((niveau === 'web' || niveau === 'conformite') && cites.length === 0)
            avert(ou, `critère ${niveau} sans nœud cité`);
          if (cites.length && cadre === '—')
            err(ou, 'un critère qui cite des nœuds doit nommer son cadre (état · taille)');
          if (cites.length && cadre !== '—') {
            const [etatsC = '', taillesC = ''] = cadre.split('·').map((x) => x.trim());
            const liste = (x) =>
              x
                .split(',')
                .map((y) => y.trim())
                .filter(Boolean);
            for (const nid of cites) {
              const fi = ficheDe.get(nid);
              if (!fi) continue;
              if (etatsC !== 'tous')
                liste(etatsC)
                  .filter((e) => !(e in fi.etats))
                  .forEach((e) =>
                    err(ou, `cadre : état \`${e}\` absent de la fiche de \`${nid}\``),
                  );
              if (taillesC !== 'toutes')
                liste(taillesC)
                  .filter((t) => !fi.tailles.includes(t))
                  .forEach((t) =>
                    err(ou, `cadre : taille \`${t}\` absente de la fiche de \`${nid}\``),
                  );
            }
          }
        }
        if (ids.size === 0) err(plan, 'aucun critère dans le contrat');
        for (const t of ['### À confirmer avant le dev', '### Points sans critère']) {
          if (!section.some((l) => l.replace('’', "'").trim() === t))
            err(plan, `sous-section « ${t} » absente`);
        }
        // Points du plan (titres ### de la forme « 41b.3 … ») sans critère ni mention.
        const texteSection = section.join('\n');
        const points = lignes
          .slice(0, debut)
          // Titres « ### 41b.3 … » ou puces en gras « - **S.4 — … » : les deux formes existent dans docs/chantiers/.
          .map(
            (l) =>
              (l.match(
                /^(?:#{3,4}\s+|\s*(?:[-*]\s+)?\*\*)([0-9A-Za-z]{1,4}\.\d+[a-z]*)(?![\w.])/,
              ) ?? [])[1],
          )
          .filter(Boolean);
        for (const p of new Set(points)) {
          if (
            !pointsCouverts.has(p) &&
            !new RegExp(`(^|[^\\w.])${p.replace('.', '\\.')}(?![\\w.]*\\d)`, 'm').test(texteSection)
          ) {
            avert(plan, `point ${p} : ni critère, ni mention dans « Points sans critère »`);
          }
        }
        for (const p of pointsCouverts)
          if (points.length && !points.includes(p))
            err(plan, `le contrat cite le point ${p}, absent des titres du plan`);
        dire(
          `Contrat : ${ids.size} critères — ` +
            Object.keys(NIVEAUX)
              .map((n) => `${n} ${compte[n] ?? 0}`)
              .join(', '),
        );
      }
    }
  }
}

if (fiches.length) dire(`Fiches : ${fiches.length} lues, ${tousNoeuds.size} nœuds.`);
if (aPoser.length) {
  dire(
    `\nNœuds dont le nom n'existe pas encore dans l'application (${aPoser.length}) — à poser par le dev :`,
  );
  aPoser.forEach((x) => dire(`  + ${x}`));
}
if (aConfirmer.length) {
  dire(`\nÀ confirmer (${aConfirmer.length}) — à remonter à l'humain avant le dev :`);
  aConfirmer.forEach((x) => dire(`  ? ${x}`));
}
if (avertissements.length) {
  dire(`\nAvertissements (${avertissements.length}) :`);
  avertissements.forEach((x) => dire(`  ! ${x}`));
}
if (erreurs.length) {
  dire(`\nErreurs (${erreurs.length}) :`);
  erreurs.forEach((x) => dire(`  ✗ ${x}`));
}
const ko = erreurs.length > 0 || (strict && (avertissements.length > 0 || aConfirmer.length > 0));
if (!ko) dire('\nValide.');
process.exit(ko ? 1 : 0);
