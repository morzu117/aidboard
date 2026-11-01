import type { Db } from '../db.js';
import { hasSecret, maskDeep } from '../secrets.js';

const TASK = 'masquer-secrets-serveurs';
const BATCH = 500;

/**
 * Chantier 20 (DM6) : passe unique sur ce qui a été écrit avant le masquage à l'entrée. Les lignes du fil sont
 * masquées (le JSON relu, chaque chaîne masquée : un masquage du texte brut casserait le JSON) ; une règle dont le
 * motif porte un secret est retirée — elle ne pourra plus jamais s'appliquer (DM3), la garder serait garder le
 * secret. Rien à faire si la migration 017 ne l'a pas demandé, ou si c'est déjà fait.
 */
export function maskStoredSecrets(db: Db): { messages: number; rules: number } | null {
  if (!db.prepare('SELECT 1 FROM maintenance WHERE task = ?').get(TASK)) return null;
  return db.transaction(() => {
    let messages = 0;
    const page = db.prepare(
      'SELECT rowid, payload FROM server_agent_messages WHERE rowid > ? ORDER BY rowid LIMIT ?',
    );
    const update = db.prepare('UPDATE server_agent_messages SET payload = ? WHERE rowid = ?');
    for (let after = 0; ;) {
      const rows = page.all(after, BATCH) as { rowid: number; payload: string }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        after = r.rowid;
        if (!hasSecret(r.payload)) continue;
        let masked: string;
        try {
          masked = JSON.stringify(maskDeep(JSON.parse(r.payload) as unknown));
        } catch {
          // ligne illisible : masquée telle quelle plutôt que gardée en clair
          masked = JSON.stringify({ type: 'message', role: 'assistant', text: '[secret masqué]' });
        }
        update.run(masked, r.rowid);
        messages++;
      }
    }
    const rules = (
      db.prepare('SELECT id, pattern FROM server_rules').all() as {
        id: string;
        pattern: string;
      }[]
    ).filter((r) => hasSecret(r.pattern));
    const drop = db.prepare('DELETE FROM server_rules WHERE id = ?');
    for (const r of rules) drop.run(r.id);
    db.prepare('DELETE FROM maintenance WHERE task = ?').run(TASK);
    return { messages, rules: rules.length };
  })();
}
