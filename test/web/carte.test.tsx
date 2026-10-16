// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { Agent, PendingRequest } from '../../src/shared/model.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId }: { agentId: string }) => (
    <div className="xterm" data-testid={`term-${agentId}`} tabIndex={0} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const c = (rest: string) => `1-1.grille.sujet-1.${rest}`;
const run = (id: string, topicId: string) => ({
  id,
  topicId,
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
});
const permission: PendingRequest = {
  id: 'p1',
  kind: 'permission',
  question: 'autoriser Bash(npm test) ?',
  options: [
    { label: 'Autoriser', answer: 'yes' },
    { label: 'Refuser', answer: 'no' },
  ],
};
const unSujet = (agents: Agent[]) =>
  snapshot({ workspaces: [ws()], topics: [topic()], runs: [run('run_1', 'tp_1')], agents });
const claude = (over: Partial<Agent> = {}) =>
  agent({ id: 'ag_c', kind: 'claude', role: 'dev', status: 'working', ...over });
const shell = agent({ id: 'ag_s', status: 'working' });

test('destinataire : l’agent le plus urgent par défaut, un clic en choisit un autre', async () => {
  setup(<Accueil />, unSujet([shell, claude({ status: 'needs_input', pending: permission })]));
  await screen.findByText('feat/s');
  expect(node(c('agent-2'))?.getAttribute('aria-pressed')).toBe('true');
  expect(node(c('agent-2'))?.className).toContain('est-destinataire');
  expect(node(c('message.champ'))?.getAttribute('placeholder')).toBe('Message à claude…');
  await userEvent.click(node(c('agent-1'))!);
  expect(node(c('agent-1'))?.getAttribute('aria-pressed')).toBe('true');
  expect(node(c('agent-2'))?.getAttribute('aria-pressed')).toBe('false');
  expect(node(c('message.champ'))?.getAttribute('placeholder')).toBe('Message à shell…');
  // la demande reste visible quel que soit le destinataire
  expect(node(c('demande'))).not.toBeNull();
});

test('aperçu : les lignes de /screen en texte, les anciennes marquées, rechargé toutes les 3 s', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const h = setup(<Accueil />, unSujet([claude()]));
  const url = '/api/agents/ag_c/screen?lines=6';
  h.respond.set(
    `GET ${url}`,
    json(200, { lines: ['un', 'deux', 'trois', '<b>quatre</b>', 'cinq', 'six'] }),
  );
  await screen.findByText('feat/s');
  await waitFor(() => expect(text(c('terminal.ligne-6'))).toBe('six'));
  expect(node(c('terminal'))?.getAttribute('aria-label')).toBe('Sortie du terminal de claude');
  expect(node(c('terminal.ligne-3'))?.className).toBe('ligne ligne--ancienne');
  expect(node(c('terminal.ligne-4'))?.className).toBe('ligne');
  expect(text(c('terminal.ligne-4'))).toBe('<b>quatre</b>');
  expect(document.querySelector('.terminal b')).toBeNull();
  const n = () => h.calls.filter((x) => x.url === url).length;
  const before = n();
  await act(() => vi.advanceTimersByTimeAsync(3100));
  expect(n()).toBeGreaterThan(before);
});

test('aperçu : pas de rechargement périodique pour un agent terminé, ni de message ni de pause', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const h = setup(<Accueil />, unSujet([claude({ status: 'done' })]));
  await screen.findByText('feat/s');
  const n = () => h.calls.filter((x) => x.url.startsWith('/api/agents/ag_c/screen')).length;
  await waitFor(() => expect(n()).toBe(1));
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(n()).toBe(1);
  expect(node(c('message'))).toBeNull();
  expect(node(c('actions.pause'))).toBeNull();
  expect(node(c('actions.agrandir'))).not.toBeNull();
});

test('demande : question et options ; un clic répond par /answer', async () => {
  const h = setup(<Accueil />, unSujet([claude({ status: 'needs_input', pending: permission })]));
  await screen.findByText('feat/s');
  expect(text(c('statut'))).toBe('Attend une réponse');
  expect(node('1-1.grille.sujet-1')?.className).toBe('carte carte--attente');
  expect(text(c('demande.question'))).toBe('claude demande : autoriser Bash(npm test) ?');
  expect(text(c('demande.option-1'))).toBe('Autoriser');
  expect(node(c('demande.option-1'))?.className).toBe('bouton bouton--primaire');
  await userEvent.click(node(c('demande.option-2'))!);
  expect(h.calls.find((x) => x.url === '/api/agents/ag_c/answer')?.body).toEqual({
    pendingId: 'p1',
    answer: 'no',
  });
});

test('demande : un 409 affiche le message et « Ouvrir le terminal »', async () => {
  const h = setup(<Accueil />, unSujet([claude({ status: 'needs_input', pending: permission })]));
  h.respond.set(
    'POST /api/agents/ag_c/answer',
    json(409, { error: 'l’écran ne montre plus cette demande : ouvrir le terminal' }),
  );
  await screen.findByText('feat/s');
  expect(node(c('demande.terminal'))).toBeNull();
  await userEvent.click(node(c('demande.option-1'))!);
  expect((await screen.findByRole('alert')).textContent).toContain('ne montre plus');
  expect(node(c('demande.terminal'))?.getAttribute('href')).toBe('/sujets/tp_1?agent=ag_c');
});

test('demande sans options (question multiple) : seulement « Ouvrir le terminal »', async () => {
  setup(
    <Accueil />,
    unSujet([
      claude({ status: 'needs_input', pending: { ...permission, kind: 'question', options: [] } }),
    ]),
  );
  await screen.findByText('feat/s');
  expect(node(c('demande.option-1'))).toBeNull();
  expect(node(c('demande.terminal'))).not.toBeNull();
});

test('message : Entrée l’envoie au destinataire par /input et vide le champ', async () => {
  const h = setup(<Accueil />, unSujet([claude({ status: 'idle' })]));
  await screen.findByText('feat/s');
  await userEvent.type(node(c('message.champ'))!, 'continue{Enter}');
  expect(h.calls.find((x) => x.url === '/api/agents/ag_c/input')?.body).toEqual({
    text: 'continue',
  });
  await waitFor(() => expect((node(c('message.champ')) as HTMLInputElement).value).toBe(''));
});

test('pause et reprise : le bouton suit l’état, l’activité dit depuis quand', async () => {
  const h = setup(<Accueil />, unSujet([claude()]));
  await screen.findByText('feat/s');
  expect(text(c('actions.pause'))).toBe('Pause');
  await userEvent.click(node(c('actions.pause'))!);
  expect(h.calls.some((x) => x.method === 'POST' && x.url === '/api/agents/ag_c/pause')).toBe(true);
  cleanup();
  const paused = new Date(Date.now() - 18 * 60_000).toISOString();
  const k = setup(<Accueil />, unSujet([claude({ pausedAt: paused })]));
  await screen.findByText('feat/s');
  expect(text(c('statut'))).toBe('En pause');
  expect(text(c('activite'))).toBe('en pause depuis 18 min');
  expect((node(c('message.champ')) as HTMLInputElement).disabled).toBe(true);
  await userEvent.click(node(c('actions.pause'))!);
  expect(k.calls.some((x) => x.url === '/api/agents/ag_c/resume')).toBe(true);
});

test('agrandir : le terminal de l’agent dans un dialogue ; Échap le ferme hors du terminal', async () => {
  setup(<Accueil />, unSujet([claude()]));
  await screen.findByText('feat/s');
  await userEvent.click(node(c('actions.agrandir'))!);
  const dlg = await screen.findByRole('dialog', { name: 'Terminal de claude' });
  const term = dlg.querySelector('[data-testid="term-ag_c"]')!;
  // Échap dans le terminal est une touche pour l'agent (refuser une permission)
  fireEvent.keyDown(term, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('statut estimé : badge et point en pointillés, infobulle au survol', async () => {
  setup(
    <Accueil />,
    unSujet([
      claude({
        status: 'idle',
        statusSource: 'heuristic',
        statusDetail: { silenceMs: 240_000, lastLine: 'Fini.', promptDetected: false },
      }),
    ]),
  );
  await screen.findByText('feat/s');
  const badge = node(c('statut'))!;
  expect(badge.className).toBe('badge badge--relire badge--estime');
  expect(text(c('estime'))).toBe('· estimé');
  expect(node(c('agent-1.statut'))?.className).toContain('point--estime');
  expect(node(c('infobulle'))).toBeNull();
  fireEvent.mouseEnter(badge.parentElement!);
  expect(text(c('infobulle.titre'))).toBe('Statut estimé');
  expect(text(c('infobulle.silence'))).toBe('Terminal silencieux depuis 4 min');
  expect(text(c('infobulle.derniere-ligne'))).toBe('Dernière ligne : « Fini. »');
  expect(text(c('infobulle.invite'))).toBe('Motif d’invite détecté : non');
  expect(text(c('infobulle.source'))).toContain('heuristique');
  fireEvent.mouseLeave(badge.parentElement!);
  expect(node(c('infobulle'))).toBeNull();
});

test('résumé et filtres de statut : comptes, un seul actif, un second clic le retire', async () => {
  setup(
    <Accueil />,
    snapshot({
      workspaces: [ws()],
      topics: [
        topic(),
        topic({ id: 'tp_2', branch: 'feat/b', slug: 'b' }),
        topic({ id: 'tp_3', branch: 'feat/c', slug: 'c' }),
      ],
      runs: [run('run_1', 'tp_1'), run('run_2', 'tp_2'), run('run_3', 'tp_3')],
      agents: [
        claude({ status: 'needs_input' }),
        claude({ id: 'ag_2', runId: 'run_2', status: 'error' }),
        claude({ id: 'ag_3', runId: 'run_3', status: 'needs_input' }),
      ],
    }),
  );
  await screen.findByText('feat/s');
  expect(text('1-1.entete.resume')).toBe('3 sujets ouverts · 2 attendent ta réponse');
  expect(text('1-1.filtres.statut-attente.compte')).toBe('2');
  expect(text('1-1.filtres.statut-erreur.compte')).toBe('1');
  expect(text('1-1.filtres.statut-pause.compte')).toBe('0');
  await userEvent.click(node('1-1.filtres.statut-erreur')!);
  expect(node('1-1.filtres.statut-erreur')?.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByText('feat/s')).toBeNull();
  expect(screen.getByText('feat/b')).toBeTruthy();
  await userEvent.click(node('1-1.filtres.statut-attente')!);
  expect(node('1-1.filtres.statut-erreur')?.getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByText('feat/b')).toBeNull();
  await userEvent.click(node('1-1.filtres.statut-attente')!);
  expect(screen.getAllByRole('article')).toHaveLength(3);
});

test('consigne à tous : seulement aux claude et codex inactifs, jamais à un shell', async () => {
  const h = setup(
    <Accueil />,
    snapshot({
      workspaces: [ws()],
      topics: [topic(), topic({ id: 'tp_2', branch: 'feat/b', slug: 'b' })],
      runs: [run('run_1', 'tp_1'), run('run_2', 'tp_2')],
      agents: [
        claude({ status: 'idle' }),
        agent({ id: 'ag_x', kind: 'codex', runId: 'run_2', status: 'idle' }),
        agent({ id: 'ag_s', status: 'idle' }),
        claude({ id: 'ag_w', status: 'working' }),
        claude({ id: 'ag_p', status: 'idle', pausedAt: 't' }),
        claude({ id: 'ag_d', status: 'done' }),
      ],
    }),
  );
  await screen.findByText('feat/s');
  expect(text('1-1.consigne.envoyer.nombre')).toBe('2');
  expect(text('1-1.consigne.aide')).toBe('Envoyée maintenant aux agents inactifs.');
  expect(document.querySelector('[data-node="1-1.consigne.globale"]')).toBeNull();
  await userEvent.type(node('1-1.consigne.champ')!, 'commits en français');
  await userEvent.click(node('1-1.consigne.envoyer')!);
  await waitFor(() => expect(text('1-1.consigne.retour')).toBe('Envoyée à 2 agents.'));
  expect(
    h.calls
      .filter((x) => x.url.endsWith('/input'))
      .map((x) => x.url)
      .sort(),
  ).toEqual(['/api/agents/ag_c/input', '/api/agents/ag_x/input']);
});

test('légende : les cinq statuts et « estimé », sans grokbot distant', async () => {
  setup(<Accueil />, unSujet([claude()]));
  await screen.findByText('feat/s');
  for (const s of ['attente', 'erreur', 'relire', 'cours', 'pause'])
    expect(node(`1-1.legende.statut-${s}`), s).not.toBeNull();
  expect(node('1-1.legende.estime')).not.toBeNull();
  expect(node('1-1.legende.distant')).toBeNull();
});
