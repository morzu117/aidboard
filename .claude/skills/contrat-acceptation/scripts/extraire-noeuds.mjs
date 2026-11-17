#!/usr/bin/env node
// Inventaire des data-node d'une maquette HTML à la convention, ou d'un composant .tsx.
// Usage : node extraire-noeuds.mjs [--json] <fichier> [<fichier>…]
// Aucune dépendance. Lit, n'écrit rien.
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const dire = (s = '') => process.stdout.write(`${s}\n`);
const alerter = (s = '') => process.stderr.write(`${s}\n`);
import { extname, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const fichiers = args.filter((a) => !a.startsWith('--'));
if (fichiers.length === 0) {
  alerter('Usage : node extraire-noeuds.mjs [--json] <fichier.html|.tsx> [...]');
  process.exit(2);
}

const attr = (balise, nom) => {
  const m = balise.match(new RegExp(`\\b${nom}="([^"]*)"`));
  return m ? m[1] : undefined;
};

// ---------- Maquette HTML ----------
function lireMaquette(chemin, texte) {
  const cadres = [];
  const debut = /<[a-zA-Z][^>]*\bdata-screen="[^"]*"[^>]*>/g;
  const bornes = [];
  for (let m; (m = debut.exec(texte));) bornes.push({ pos: m.index, balise: m[0] });
  // Des data-node mais pas de cadre déclaré : un seul cadre, signalé comme tel.
  if (bornes.length === 0 && /\bdata-node="/.test(texte)) bornes.push({ pos: 0, balise: '' });
  bornes.forEach((b, i) => {
    const fin = i + 1 < bornes.length ? bornes[i + 1].pos : texte.length;
    const segment = texte.slice(b.pos, fin);
    const noeuds = [];
    const vus = new Set();
    const doublons = new Set();
    for (const m of segment.matchAll(/<[a-zA-Z][^>]*\bdata-node="([^"]+)"[^>]*>/g)) {
      // Trous des exports design : {{m.id}} -> {id} (forme admise par le validateur)
      const id = m[1].replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => `{${e.split('.').pop()}}`);
      if (vus.has(id)) doublons.add(id);
      vus.add(id);
      const n = { id };
      for (const [cle, a] of [
        ['action', 'data-action'],
        ['bind', 'data-bind'],
        ['layer', 'data-layer'],
      ]) {
        const v = attr(m[0], a);
        if (v !== undefined) n[cle] = v;
      }
      if (/\bdisabled\b/.test(m[0])) n.desactive = true;
      noeuds.push(n);
    }
    cadres.push({
      ecran: attr(b.balise, 'data-screen') ?? '(non déclaré)',
      etat: attr(b.balise, 'data-state') ?? '(non déclaré)',
      taille: attr(b.balise, 'data-viewport') ?? '(non déclarée)',
      noeuds,
      doublons: [...doublons],
    });
  });
  return { fichier: chemin, type: 'maquette', cadres };
}

// Indices répétés -> gabarit : sujet-3 => sujet-{n}
// Le premier segment est le préfixe d'écran (« 2-7 ») : on n'y touche pas.
const gabarit = (id) => {
  const [ecran, ...reste] = id.split('.');
  return [ecran, ...reste.map((s) => s.replace(/-\d+$/, '-{n}'))].join('.');
};

function resumeMaquette(r) {
  const lignes = [];
  const etats = [...new Set(r.cadres.map((c) => c.etat))];
  const tailles = [...new Set(r.cadres.map((c) => c.taille))];
  lignes.push(`${r.fichier}`);
  lignes.push(
    `  écran ${[...new Set(r.cadres.map((c) => c.ecran))].join(', ')} · ${r.cadres.length} cadres · états : ${etats.join(', ')} · tailles : ${tailles.join(', ')}`,
  );
  const parEtat = new Map();
  for (const c of r.cadres) {
    const s = parEtat.get(c.etat) ?? new Set();
    c.noeuds.forEach((n) => s.add(gabarit(n.id)));
    parEtat.set(c.etat, s);
  }
  const ref = parEtat.get('default') ?? parEtat.values().next().value ?? new Set();
  for (const [etat, s] of parEtat) {
    lignes.push(`\n  [${etat}] ${s.size} nœuds (indices regroupés)`);
    if (etat === 'default' || s === ref) {
      [...s].forEach((id) => lignes.push(`    ${id}`));
    } else {
      const plus = [...s].filter((x) => !ref.has(x));
      const moins = [...ref].filter((x) => !s.has(x));
      plus.forEach((id) => lignes.push(`    + ${id}`));
      lignes.push(`    − ${moins.length} nœuds de default absents`);
    }
  }
  // Cohérence entre tailles d'un même état : la convention veut le même jeu de nœuds.
  for (const etat of etats) {
    const cs = r.cadres.filter((c) => c.etat === etat);
    const base = new Set(cs[0].noeuds.map((n) => n.id));
    for (const c of cs.slice(1)) {
      const autre = new Set(c.noeuds.map((n) => n.id));
      const diff =
        [...base].filter((x) => !autre.has(x)).length +
        [...autre].filter((x) => !base.has(x)).length;
      if (diff > 0)
        lignes.push(`\n  ! [${etat}] ${cs[0].taille} et ${c.taille} diffèrent de ${diff} nœuds`);
    }
  }
  const dbl = r.cadres.filter((c) => c.doublons.length);
  dbl.forEach((c) =>
    lignes.push(`  ! [${c.etat} · ${c.taille}] doublons : ${c.doublons.join(', ')}`),
  );
  const actions = new Set();
  const binds = new Set();
  r.cadres.forEach((c) =>
    c.noeuds.forEach((n) => {
      if (n.action) actions.add(n.action);
      if (n.bind) binds.add(n.bind);
    }),
  );
  if (actions.size) lignes.push(`\n  data-action : ${[...actions].sort().join(', ')}`);
  if (binds.size) lignes.push(`  data-bind : ${[...binds].sort().join(', ')}`);
  return lignes.join('\n');
}

// ---------- Composant TSX ----------
// ${c.id} -> {id} : le dernier segment suffit, et c'est la forme que le validateur admet.
const trous = (s) =>
  s.replace(
    /\$\{\s*([^}]+?)\s*\}/g,
    (_, e) => `{${(e.replace(/\s+/g, '').match(/[A-Za-z0-9_]+$/) ?? ['x'])[0]}}`,
  );

function lireComposant(chemin, texte) {
  const lignesSrc = texte.split(/\r?\n/);
  // Préfixes : const n = (rest: string) => `machines.${rest}`;
  const prefixes = new Map();
  for (const m of texte.matchAll(
    /const\s+(\w+)\s*=\s*\(\s*(\w+)\s*(?::\s*string)?\s*\)\s*=>\s*`([^`]*)`/g,
  )) {
    prefixes.set(m[1], { param: m[2], tpl: m[3] });
  }
  const noeuds = [];
  const nonResolus = [];
  lignesSrc.forEach((ligne, i) => {
    for (const m of ligne.matchAll(/data-node=(?:"([^"]+)"|\{)/g)) {
      const n = i + 1;
      if (m[1] !== undefined) {
        noeuds.push({ id: m[1], ligne: n });
        continue;
      }
      // Expression JSX : on avance jusqu'à l'accolade fermante appariée.
      let prof = 1;
      let j = m.index + m[0].length;
      while (j < ligne.length && prof > 0) {
        if (ligne[j] === '{') prof++;
        else if (ligne[j] === '}') prof--;
        j++;
      }
      const expr = ligne.slice(m.index + m[0].length, prof === 0 ? j - 1 : ligne.length).trim();
      let r;
      if ((r = expr.match(/^`([^`]*)`$/))) {
        noeuds.push({ id: trous(r[1]), ligne: n });
      } else if (
        (r = expr.match(/^(\w+)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*\)$/)) &&
        prefixes.has(r[1])
      ) {
        const p = prefixes.get(r[1]);
        const arg = r[2] ?? r[3] ?? r[4];
        const id = p.tpl.replace(new RegExp(`\\$\\{\\s*${p.param}\\s*\\}`), arg);
        noeuds.push({ id: trous(id), ligne: n });
      } else {
        nonResolus.push({ expression: expr, ligne: n });
      }
    }
  });
  // Préfixes passés à un composant enfant : <Statut dataNode="machines.statut" /> — l'enfant pose
  // ses propres nœuds sous ce préfixe, il faut l'extraire aussi.
  const transmis = [];
  lignesSrc.forEach((ligne, i) => {
    for (const m of ligne.matchAll(/<(\w+)[^>]*\bdataNode=(?:"([^"]+)"|\{`([^`]*)`\})/g)) {
      transmis.push({ composant: m[1], prefixe: m[2] ?? trous(m[3]), ligne: i + 1 });
    }
  });
  // Composants locaux importés qui portent eux-mêmes des data-node.
  const importes = [];
  for (const m of texte.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    for (const ext of ['.tsx', '/index.tsx']) {
      // Les imports du dépôt portent l'extension .js (ESM) : le source est le .tsx voisin.
      const cible = join(dirname(chemin), m[1].replace(/\.jsx?$/, '') + ext);
      if (existsSync(cible) && /data-node=/.test(readFileSync(cible, 'utf8'))) {
        importes.push(cible.replace(/\\/g, '/'));
        break;
      }
    }
  }
  return { fichier: chemin, type: 'composant', noeuds, nonResolus, transmis, importes };
}

function resumeComposant(r) {
  const lignes = [
    `${r.fichier}`,
    `  ${r.noeuds.length} data-node résolus, ${r.nonResolus.length} à résoudre à la main`,
  ];
  const vus = new Set();
  for (const n of r.noeuds) {
    if (vus.has(n.id)) continue;
    vus.add(n.id);
    lignes.push(`    ${n.id}   (l.${n.ligne})`);
  }
  if (r.nonResolus.length) {
    lignes.push('\n  À résoudre (expression calculée — lire ces lignes) :');
    r.nonResolus.forEach((x) => lignes.push(`    l.${x.ligne}  data-node={${x.expression}}`));
  }
  if (r.transmis.length) {
    lignes.push('\n  Préfixes passés à un composant enfant (ses nœuds vivent sous ce préfixe) :');
    r.transmis.forEach((x) => lignes.push(`    l.${x.ligne}  <${x.composant}> → ${x.prefixe}.…`));
  }
  if (r.importes.length) {
    lignes.push('\n  Composants importés qui posent des data-node (à extraire aussi) :');
    r.importes.forEach((x) => lignes.push(`    ${x}`));
  }
  return lignes.join('\n');
}

// ---------- Sortie ----------
const resultats = [];
let echec = false;
for (const f of fichiers) {
  let texte;
  try {
    texte = readFileSync(f, 'utf8');
  } catch (e) {
    alerter(`Illisible : ${f} (${e.code ?? e.message})`);
    echec = true;
    continue;
  }
  const ext = extname(f).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    const r = lireMaquette(f, texte);
    if (r.cadres.length === 0) {
      alerter(
        `${f} : aucun data-node. Ce n'est pas une maquette à la convention ` +
          `(export .dc.html ? voir references/sources-design.md).`,
      );
      echec = true;
      continue;
    }
    resultats.push(r);
  } else {
    resultats.push(lireComposant(f, texte));
  }
}
if (json) dire(JSON.stringify(resultats, null, 2));
else
  dire(
    resultats
      .map((r) => (r.type === 'maquette' ? resumeMaquette(r) : resumeComposant(r)))
      .join('\n\n'),
  );
process.exit(echec ? 1 : 0);
