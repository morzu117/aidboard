import { beforeAll, expect, test } from 'vitest';
import { waitFor } from '../helpers/daemon.js';
import { monterBanc } from './daemon-labo.js';

/**
 * Chantier 21 : le piège du VPS du 2026-11-01, rejoué. `claude` n'existe que dans les shims de mise, et
 * `mise activate` est dans le `.bashrc` après le garde de Debian (`case $- in *i*`) : un shell interactif
 * le trouve, le shell de connexion non interactif d'A-I-D non. Le daemon doit le trouver quand même.
 */
const b = monterBanc();
const SHIMS = '/home/aid/.local/share/mise/shims';

beforeAll(() => {
  const labo = b.labo();
  labo.exec('mv /usr/local/bin/claude /opt/claude-mise');
  labo.exec(
    `mkdir -p ${SHIMS} && ln -s /opt/claude-mise ${SHIMS}/claude && grep -q 'case \\$- in' ~/.bashrc && printf '%s\\n' 'export PATH="$HOME/.local/share/mise/shims:$PATH"' >> ~/.bashrc`,
    'aid',
  );
  // le piège est bien en place : trouvé en interactif seulement
  expect(labo.exec("bash -lc 'command -v claude || echo absent'", 'aid').trim()).toBe('absent');
  expect(labo.exec("bash -ic 'command -v claude' 2>/dev/null", 'aid').trim()).toBe(
    `${SHIMS}/claude`,
  );
});

test('claude dans les shims de mise : détecté par le test de connexion, puis lancé dans tmux', async () => {
  const m = await b.daemon();
  const s = await b.creerServeur(m);
  const row = m.t.db.prepare('SELECT detected_agents FROM servers WHERE id = ?').get(s.id) as {
    detected_agents: string;
  };
  expect(JSON.parse(row.detected_agents)).toEqual(['claude', 'codex']);

  const d = await b.creerDiscussion(m, s.id);
  const a = d.agents[0]!;
  await b.envoyer(m, a.id, 'bonjour');
  await waitFor(() => b.assistant(m, a.id, 'echo: bonjour') === 1, 20_000, 'réponse');
  expect(b.sessions()).toEqual([`aid-${a.id}`]);
  expect(b.agentsDuServeur()).toHaveLength(1);
});
