import { expect, test } from 'vitest';
import type { ServerAgentView, ServerDiscussionView } from '../../src/daemon/remote/agents.js';
import type { Server } from '../../src/shared/model.js';
import { waitFor } from '../helpers/daemon.js';
import { type Banc, monterBanc } from './daemon-labo.js';

/**
 * Chantier 18, L.4 : les confirmations du chantier 17 (R.5, D.4) à travers le vrai ssh — la carte, la
 * réponse et la règle font l'aller-retour complet, et un redémarrage du daemon pendant une carte.
 */
const b = monterBanc();
const {
  daemon,
  arreter,
  creerServeur,
  creerDiscussion,
  ligne,
  assistant,
  envoyer,
  agentsDuServeur,
} = b;
type Monte = Awaited<ReturnType<Banc['daemon']>>;

const CONFIRMATION = ['Autoriser', 'Refuser', 'Toujours autoriser dans ce dossier'];

async function carte(m: Monte, agentId: string, command: string): Promise<ServerAgentView> {
  await envoyer(m, agentId, `commande: ${command}`);
  await waitFor(() => ligne(m, agentId)?.status === 'needs_input', 20_000, `carte ${command}`);
  const view = (await m.req('GET', `/api/server-agents/${agentId}`)).json<ServerAgentView>();
  expect(view.pending).not.toBeNull();
  return view;
}

async function repondre(m: Monte, view: ServerAgentView, answer: string): Promise<void> {
  const r = await m.req('POST', `/api/server-agents/${view.id}/answer`, {
    pendingId: view.pending!.id,
    answer,
  });
  expect(r.statusCode, r.body).toBe(202);
}

test('destructif : carte de confirmation, refus, « Toujours autoriser dans ce dossier » ; ailleurs, redemandé', async () => {
  const m = await daemon();
  const s = await creerServeur(m);
  const d = await creerDiscussion(m, s.id);
  const a = d.agents[0]!;

  const v1 = await carte(m, a.id, 'echo debut && rm -f x');
  expect(v1.pending).toMatchObject({
    command: 'echo debut && rm -f x',
    byRule: true,
    confirm: { server: 'labo' },
  });
  expect(v1.pending!.options.map((o) => o.label)).toEqual(CONFIRMATION);
  await repondre(m, v1, 'no');
  await waitFor(() => assistant(m, a.id, 'refusée: echo debut && rm -f x') === 1, 20_000, 'refus');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 20_000, 'idle');

  const v2 = await carte(m, a.id, 'rm -f y');
  await repondre(m, v2, 'always');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f y') === 1, 20_000, 'toujours');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 20_000, 'idle');
  const regles = (await m.req('GET', `/api/servers/${s.id}`)).json<Server>().rules;
  expect(regles.map((r) => [r.cwd, r.pattern])).toEqual([[d.cwd, 'rm -f y']]);

  // même dossier : la règle répond seule
  await envoyer(m, a.id, 'commande: rm -f y');
  await waitFor(() => assistant(m, a.id, 'exécutée: rm -f y') === 2, 20_000, 'par règle');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 20_000, 'idle');

  // autre dossier du même serveur : redemandé
  b.labo().exec('mkdir -p ~/autre', 'aid');
  const r = await m.req('POST', `/api/servers/${s.id}/discussions`, {
    name: 'Ailleurs',
    kind: 'claude',
    cwd: '~/autre',
  });
  expect(r.statusCode, r.body).toBe(201);
  const autre = r.json<ServerDiscussionView>().agents[0]!;
  const v3 = await carte(m, autre.id, 'rm -f y');
  expect(v3.pending!.confirm).toEqual({ server: 'labo' });
  await repondre(m, v3, 'no');
  await waitFor(() => assistant(m, autre.id, 'refusée: rm -f y') === 1, 20_000, 'refus ailleurs');
});

test('redémarrage du daemon pendant une carte : plus de demande fantôme, le tour est interrompu', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await carte(m1, a.id, 'rm -f z');
  const pids = agentsDuServeur();
  await arreter(m1);

  // la carte est perdue avec la mémoire du daemon : effacée, le tour interrompu (revue R.4). La réaction du
  // vrai claude à cette interruption reste à observer (journal du chantier 17) : le faux garde son tour
  // ouvert, le test s'arrête donc au contrat du daemon.
  const m2 = await daemon(m1.t.home);
  expect(ligne(m2, a.id)!.status).toBe('working');
  expect(
    (await m2.req('GET', `/api/server-agents/${a.id}`)).json<ServerAgentView>().pending,
  ).toBeNull();
  expect((await m2.req('POST', `/api/server-agents/${a.id}/interrupt`)).statusCode).toBe(202);
  expect(agentsDuServeur()).toEqual(pids);
  expect(assistant(m2, a.id, 'exécutée: rm -f z')).toBe(0);
});
