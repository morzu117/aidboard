import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as attendre } from 'node:timers/promises';
import { URL } from 'node:url';

const [dossier, fournisseur, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(fournisseur === 'claude' ? '2.1.0\n' : 'codex-cli 0.166.0\n');
  process.exit(0);
}

const relatif = relative(dossier, process.cwd());
if (!relatif || relatif.startsWith('..') || isAbsolute(relatif) || process.env.HOME !== dossier) {
  throw new Error('Le faux agent doit tourner dans le dossier isolé du scénario');
}

const mode = readFileSync(join(dossier, 'scenario'), 'utf8');
const session = fournisseur === 'claude' ? args[args.indexOf('--session-id') + 1] : randomUUID();
appendFileSync(join(dossier, 'processus-agents'), fournisseur + '\n');
const envoyer = (objet) => process.stdout.write(JSON.stringify(objet) + '\n');
const claude = (objet) => envoyer({ ...objet, session_id: session });
const git = (...argumentsGit) => execFileSync('git', argumentsGit, { encoding: 'utf8' }).trim();
const journal = (role, evenement) =>
  appendFileSync(
    join(dossier, 'agents.jsonl'),
    JSON.stringify({ role, evenement, session }) + '\n',
  );

let role;
let sujet;

async function jouer(texte) {
  if (!role) {
    role = /^# Rôle — (\w+)/m.exec(texte)?.[1];
    sujet = /^Sujet : (aid\/[a-z0-9-]+)$/m.exec(texte)?.[1];
    if (!role || !sujet) throw new Error('Rôle ou sujet absent du message du daemon');
    journal(role, 'lancement');
  }
  journal(role, 'tour');

  switch (role) {
    case 'plan':
      return '## 69.7 — Note de scénario\nÉcrire la note et vérifier son contenu.';
    case 'acceptation':
      if (mode === 'nominal' || mode === 'double-go') {
        while (!existsSync(join(dossier, 'fin-acceptation'))) await attendre(25);
      }
      mkdirSync('test', { recursive: true });
      writeFileSync(
        'test/note.test.cjs',
        "const { readFileSync } = require('node:fs');\n" +
          "require('node:assert/strict').equal(readFileSync('note.txt', 'utf8'), 'Note vérifiée.\\n');\n",
      );
      git('add', 'test/note.test.cjs');
      git('commit', '-qm', 'Test de la note', '-m', 'Acceptation: 69.7');
      return 'Test ajouté.';
    case 'dev': {
      if (mode === 'sans-artefact') return 'Tour terminé.';
      if (mode === 'arret' || mode === 'redemarrage') {
        const enfant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        // Le parent reste vivant le temps de récolter le statut de son enfant.
        process.on('SIGTERM', () => enfant.once('exit', () => process.exit(0)));
        writeFileSync(join(dossier, 'pids.json'), JSON.stringify([process.pid, enfant.pid]));
        await new Promise((resoudre) => enfant.once('exit', resoudre));
        return 'Enfant terminé.';
      }
      const redev = existsSync('note.txt');
      writeFileSync(redev ? 'precision.txt' : 'note.txt', 'Note vérifiée.\n');
      git('add', redev ? 'precision.txt' : 'note.txt');
      git('commit', '-qm', redev ? 'Préciser la note' : 'Écrire la note');
      const url = new URL(process.env.AID_URL);
      if (url.hostname !== '127.0.0.1') throw new Error('Daemon de scénario local attendu');
      const page = sujet.replace('aid/', 'aid/dev-handoff/');
      const reponse = await globalThis.fetch(new URL('/api/memory/pages/' + page, url), {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + process.env.AID_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'La note a été écrite et commitée.\n', mode: 'append' }),
        signal: globalThis.AbortSignal.timeout(5_000),
      });
      if (!reponse.ok) throw new Error('Écriture du handoff refusée (' + reponse.status + ')');
      if (mode === 'nominal') {
        while (!existsSync(join(dossier, 'fin-dev'))) await attendre(25);
      }
      return 'Dev terminé.';
    }
    case 'review': {
      if (mode === 'revue-vide') return 'CLEAN';
      while (!existsSync(join(dossier, 'fin-revue'))) await attendre(25);
      return (
        '\x60\x60\x60json\n' +
        JSON.stringify({
          tete: git('rev-parse', 'HEAD'),
          verdicts: {
            fichiers: { 'note.txt': 'pass', 'test/note.test.cjs': 'pass' },
            points: { 69.7: 'pass' },
          },
          findings: [],
        }) +
        '\n\x60\x60\x60'
      );
    }
    default:
      throw new Error('Rôle inattendu');
  }
}

for await (const ligne of createInterface({ input: process.stdin })) {
  const message = JSON.parse(ligne);
  if (fournisseur === 'claude') {
    if (message.type !== 'user') continue;
    if (!role) claude({ type: 'system', subtype: 'init', cwd: process.cwd() });
    const texte = await jouer(message.message.content);
    claude({ type: 'assistant', message: { content: [{ type: 'text', text: texte }] } });
    claude({ type: 'result', subtype: 'success', result: texte });
  } else if (message.id !== undefined) {
    const repondre = (result) => envoyer({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'thread/start') {
      repondre({ thread: { id: session } });
    } else if (message.method === 'turn/start') {
      const turn = { id: randomUUID(), status: 'completed' };
      repondre({ turn });
      const texte = await jouer(message.params.input.map(({ text }) => text).join('\n'));
      envoyer({
        method: 'item/completed',
        params: { item: { id: randomUUID(), type: 'agentMessage', text: texte } },
      });
      envoyer({ method: 'turn/completed', params: { turn } });
    } else {
      repondre({});
    }
  }
}
