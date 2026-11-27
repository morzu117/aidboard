import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as attendre } from 'node:timers/promises';

const [dossier, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0\n');
  process.exit(0);
}

const session = args[args.indexOf('--session-id') + 1] ?? 'session-fictive';
const envoyer = (objet) =>
  process.stdout.write(JSON.stringify({ ...objet, session_id: session }) + '\n');
const entree = createInterface({ input: process.stdin });

for await (const ligne of entree) {
  const message = JSON.parse(ligne);
  if (message.type === 'control_response' || message.type === 'user') {
    const contenu = message.message?.content;
    const texte = typeof contenu === 'string' ? contenu : JSON.stringify(contenu ?? '');
    if (texte.includes('Rôle — plan')) {
      envoyer({ type: 'system', subtype: 'init', cwd: process.cwd() });
      while (!existsSync(join(dossier, 'plan-ecrit'))) await attendre(25);
      envoyer({ type: 'result', subtype: 'success' });
    } else if (texte.includes('Rôle — dev')) {
      writeFileSync(join(dossier, 'dev-pid'), String(process.pid));
      envoyer({ type: 'system', subtype: 'init', cwd: process.cwd() });
      envoyer({
        type: 'control_request',
        request_id: 'question-fictive',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Quel format ?',
                header: 'Format',
                options: [{ label: 'Texte' }, { label: 'Tableau' }],
              },
            ],
          },
        },
      });
    } else if (JSON.stringify(message).includes('Texte')) {
      writeFileSync(join(dossier, 'reponse-recue'), 'Texte');
    }
  }
}
