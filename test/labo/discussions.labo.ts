import { expect, test } from 'vitest';
import { waitFor } from '../helpers/daemon.js';
import { monterBanc } from './daemon-labo.js';

/**
 * Chantier 18, L.3 : les discussions de serveur de bout en bout — daemon réel, vrai ssh, vrai sshd, vrai
 * tmux ; seuls les agents sont faux (enveloppés en `claude` et `codex` sur le serveur, DL5).
 */
const b = monterBanc();
const {
  daemon,
  arreter,
  creerServeur,
  creerDiscussion,
  ligne,
  fil,
  assistant,
  envoyer,
  sessions,
  agentsDuServeur,
} = b;

test('claude : échange, redémarrage du daemon rattaché, coupure réseau en plein tour, suppression', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const d = await creerDiscussion(m1, s.id);
  const a = d.agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => assistant(m1, a.id, 'echo: bonjour') === 1, 20_000, 'réponse');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 20_000, 'idle');
  expect(sessions()).toEqual([`aid-${a.id}`]);
  const pids = agentsDuServeur();
  expect(pids).toHaveLength(1);

  // le daemon s'arrête : l'agent continue sur le serveur (D73) ; le suivant se rattache au même relais
  await arreter(m1);
  expect(agentsDuServeur()).toEqual(pids);
  const m2 = await daemon(m1.t.home);
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 20_000, 'réponse après redémarrage');
  await waitFor(() => ligne(m2, a.id)?.status === 'idle', 20_000, 'idle');
  expect(agentsDuServeur()).toEqual(pids);
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);

  // coupure en plein tour : les connexions tombent, le serveur refuse un temps, puis revient
  await envoyer(m2, a.id, 'tour long');
  await waitFor(() => assistant(m2, a.id, 'tour long démarré') === 1, 20_000, 'tour long');
  b.labo().couper();
  await waitFor(
    () => fil(m2, a.id).some((e) => e.type === 'connection_lost'),
    20_000,
    'perte de lien',
  );
  await new Promise((r) => setTimeout(r, 1_500));
  b.labo().retablir();
  await waitFor(
    () => fil(m2, a.id).some((e) => e.type === 'connection_resumed'),
    30_000,
    'lien rétabli',
  );
  expect(agentsDuServeur()).toEqual(pids);
  expect((await m2.req('POST', `/api/server-agents/${a.id}/interrupt`)).statusCode).toBeLessThan(
    300,
  );
  await waitFor(() => ligne(m2, a.id)?.status === 'idle', 20_000, 'tour interrompu');
  expect(assistant(m2, a.id, 'tour long démarré')).toBe(1);
  expect(
    fil(m2, a.id)
      .filter((e) => e.role === 'user')
      .map((e) => e.text),
  ).toEqual(['bonjour', 'deux', 'tour long']);

  expect((await m2.req('DELETE', `/api/servers/${s.id}/discussions/${d.id}`)).statusCode).toBe(204);
  await waitFor(() => agentsDuServeur().length === 0, 20_000, 'agent arrêté sur le serveur');
  expect(sessions()).toEqual([]);
});

test('codex : échange, redémarrage du daemon, reprise du fil sous un relais neuf', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id, 'codex')).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(
    () => ligne(m1, a.id)?.status === 'idle' && assistant(m1, a.id, 'echo: bonjour') >= 1,
    20_000,
    'réponse',
  );
  const thread = ligne(m1, a.id)!.session_id;
  expect(thread).toBeTruthy();
  await arreter(m1);

  const m2 = await daemon(m1.t.home);
  // l'ancien relais est arrêté au démarrage (reattachAll) : plus d'agent ni de session sur le serveur
  await waitFor(
    () => agentsDuServeur().length === 0 && sessions().length === 0,
    20_000,
    'ancien relais',
  );
  await envoyer(m2, a.id, 'deux');
  await waitFor(
    () => ligne(m2, a.id)?.status === 'idle' && assistant(m2, a.id, 'echo: deux') >= 1,
    20_000,
    'reprise',
  );
  const apres = ligne(m2, a.id)!;
  expect(apres.session_id).toBe(thread);
  expect(apres.tmux_session.startsWith(`aid-${a.id}-`)).toBe(true);
  expect(sessions()).toEqual([apres.tmux_session]);
});

test('supprimer un serveur coupé : 409, l’agent tourne encore ; revenu, la suppression l’arrête (D.2)', async () => {
  const m = await daemon();
  const s = await creerServeur(m);
  const a = (await creerDiscussion(m, s.id)).agents[0]!;
  await envoyer(m, a.id, 'bonjour');
  await waitFor(() => ligne(m, a.id)?.status === 'idle', 20_000, 'idle');

  b.labo().couper();
  const r = await m.req('DELETE', `/api/servers/${s.id}`);
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json<{ unconfirmed: number }>().unconfirmed).toBe(1);
  expect(agentsDuServeur()).toHaveLength(1);
  expect((await m.req('GET', `/api/servers/${s.id}`)).statusCode).toBe(200);

  b.labo().retablir();
  expect((await m.req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(204);
  await waitFor(() => agentsDuServeur().length === 0, 20_000, 'agent arrêté');
  expect(sessions()).toEqual([]);
});

test('chantier 19, S.4 : daemon redémarré serveur coupé — claude jamais en erreur, rattaché au même agent une fois rétabli', async () => {
  const m1 = await daemon();
  const s = await creerServeur(m1);
  const a = (await creerDiscussion(m1, s.id)).agents[0]!;
  await envoyer(m1, a.id, 'bonjour');
  await waitFor(() => ligne(m1, a.id)?.status === 'idle', 20_000, 'idle');
  const pids = agentsDuServeur();
  await arreter(m1);

  b.labo().couper();
  const m2 = await daemon(m1.t.home);
  // plusieurs rattachements refusés par le vrai sshd : l'agent n'est pas fini
  await new Promise((r) => setTimeout(r, 4_000));
  expect(ligne(m2, a.id)!.status).not.toBe('error');
  b.labo().retablir();
  await envoyer(m2, a.id, 'deux');
  await waitFor(() => assistant(m2, a.id, 'echo: deux') === 1, 30_000, 'réponse');
  expect(agentsDuServeur()).toEqual(pids);
  expect(ligne(m2, a.id)!.tmux_session).toBe(`aid-${a.id}`);
  expect(assistant(m2, a.id, 'echo: bonjour')).toBe(1);
});
