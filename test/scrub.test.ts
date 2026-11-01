import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { maskStoredSecrets } from '../src/daemon/remote/scrub.js';

/** Chantier 20, M.5 (DM6) : la passe unique sur l'historique, hors daemon. */
test('ligne illisible à secret remplacée, lignes propres intactes, passe consommée', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-scrub-')), 'aid.db'));
  db.pragma('foreign_keys = OFF');
  const ecrire = db.prepare(
    'INSERT INTO server_agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
  );
  ecrire.run('sa_x', 1, 'message', '{"text":"coupé ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 't');
  ecrire.run('sa_x', 2, 'message', '{"type":"message","role":"assistant","text":"rien"}', 't');
  // un lot de 500 franchi : la pagination va jusqu'au bout
  for (let i = 3; i < 1203; i++)
    ecrire.run(
      'sa_x',
      i,
      'message',
      JSON.stringify({ text: i === 1202 ? 'AKIAIOSFODNN7EXAMPLE' : 'x' }),
      't',
    );
  expect(maskStoredSecrets(db)).toEqual({ messages: 2, rules: 0 });
  const p = (seq: number) =>
    (
      db.prepare('SELECT payload FROM server_agent_messages WHERE seq = ?').get(seq) as {
        payload: string;
      }
    ).payload;
  expect(JSON.parse(p(1))).toEqual({ type: 'message', role: 'assistant', text: '[secret masqué]' });
  expect(p(2)).toBe('{"type":"message","role":"assistant","text":"rien"}');
  expect(JSON.parse(p(1202))).toEqual({ text: 'AKIA[secret masqué]' });
  // consommée : un second appel ne fait rien
  expect(maskStoredSecrets(db)).toBeNull();
  db.close();
});
