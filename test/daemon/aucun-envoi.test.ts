import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { VERBES_LECTURE, VERBES_PROXY } from '../../src/daemon/mesh/proxy.js';

const racine = join(import.meta.dirname, '../..');
function fichiers(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dossier, entree.name);
    return entree.isDirectory() ? fichiers(chemin) : [chemin];
  });
}
function verifier(source: string, nom: string): string[] {
  const erreurs: string[] = [];
  const arbre = ts.createSourceFile(nom, source, ts.ScriptTarget.Latest, true);
  const texte = (n: ts.Node) => (ts.isStringLiteralLike(n) ? n.text : '');
  const ecriture = (s: string) => /^(say|send|post|take|decline|close|move)$/.test(s);
  const visiter = (n: ts.Node, dansArgv = false) => {
    const autorise =
      dansArgv ||
      (nom === 'src/shared/ecritures.ts' &&
        ts.isFunctionDeclaration(n) &&
        n.name?.text === 'argvEcriture');
    if (ts.isArrayLiteralExpression(n) && !autorise) {
      // La table des méthodes HTTP du host ne contient aucun argv.
      const http =
        n.elements.length === 2 &&
        texte(n.elements[0]!) === 'post' &&
        texte(n.elements[1]!).startsWith('/api/');
      if (!http && n.elements.some((e) => ecriture(texte(e)))) erreurs.push('argv écriture');
    }
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const module = n.moduleSpecifier && texte(n.moduleSpecifier);
      if (
        module &&
        /(?:mesh\/proxy|\.\/proxy)\.js$/.test(module) &&
        !nom.startsWith('src/daemon/confirmations/') &&
        // 44.2 : le lecteur n'a que VERBES_LECTURE (test « les lectures ne disposent que… »)
        nom !== 'src/daemon/mesh/lecteur.ts'
      )
        erreurs.push('import proxy');
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(arbre) === 'import' &&
      n.arguments.some((a) => /proxy\.js$/.test(texte(a))) &&
      !nom.startsWith('src/daemon/confirmations/')
    )
      erreurs.push('import proxy');
    if (
      ts.isStringLiteralLike(n) &&
      n.text.startsWith('/api/') &&
      /(?:(?:ecrire|etat)\/|envoyer|\/(?:say|send|post|take|decline|close|move)(?:\/|$))/.test(
        n.text,
      ) &&
      ![
        '/api/swarph/ecrire/apercu',
        '/api/swarph/ecrire/envoyer',
        '/api/swarph/etat/envoyer',
      ].includes(n.text)
    )
      erreurs.push('route écriture');
    if (
      ts.isCallExpression(n) &&
      /(?:spawn|execFile)(?:Sync)?$/.test(n.expression.getText(arbre)) &&
      n.arguments.some((a) => /swarph/.test(texte(a))) &&
      /['"](?:say|send|post|take|decline|close|move)['"]/.test(n.getText(arbre))
    )
      erreurs.push('spawn écriture');
    ts.forEachChild(n, (enfant) => visiter(enfant, autorise));
  };
  visiter(arbre);
  return erreurs;
}
test('D268 : seuls le catalogue argv et la porte permettent une écriture', () => {
  for (const fichier of ['src/daemon', 'src/shared'].flatMap((d) => fichiers(join(racine, d)))) {
    const nom = relative(racine, fichier);
    expect(verifier(readFileSync(fichier, 'utf8'), nom), nom).toEqual([]);
  }
});
test('le garde-fou détecte argv, import, route et spawn hors porte', () => {
  const source = `import { creerProxyClient } from './mesh/proxy.js';
    const argv = ['mesh', 'send'];
    app.post('/api/swarph/mesh/envoyer', handler);
    spawn('swarph', ['channel', 'post']);`;
  expect(verifier(source, 'src/daemon/contournement.ts')).toEqual(
    expect.arrayContaining(['argv écriture', 'import proxy', 'route écriture', 'spawn écriture']),
  );
  expect(verifier(`function autre() { return ['send']; }`, 'src/shared/ecritures.ts')).toContain(
    'argv écriture',
  );
});

test('D268 étendu : ni argv ni route parallèle pour les états', () => {
  expect(
    verifier("const argv = ['board', 'obligations', 'take'];", 'src/daemon/autre.ts'),
  ).toContain('argv écriture');
  for (const chemin of ['/api/swarph/etat/autre', '/api/swarph/obligations/close']) {
    expect(verifier(`app.post('${chemin}', handler);`, 'src/daemon/autre.ts')).toContain(
      'route écriture',
    );
  }
});

test('D268 : les lectures ne disposent que des verbes de VERBES_LECTURE', () => {
  const source = readFileSync(join(racine, 'src/daemon/mesh/lecteur.ts'), 'utf8');
  expect(source).toContain('creerProxyClient({ socket, verbes: VERBES_LECTURE })');
  for (const verbe of VERBES_PROXY) expect(source).not.toContain(verbe);
  const verbes = [...source.matchAll(/verb = '(.*?)'/g)].map((m) => m[1]);
  for (const verbe of verbes) expect(VERBES_LECTURE).toContain(verbe);
  for (const nom of ['board.ts', 'lectures.ts']) {
    const reader = readFileSync(join(racine, 'src/daemon/mesh', nom), 'utf8');
    expect(reader).not.toMatch(/creerProxyClient|\.appeler\(/);
  }
});
