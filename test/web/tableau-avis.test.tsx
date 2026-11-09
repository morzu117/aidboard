// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { Ask, AskResult } from '../../src/shared/swairm-ask.js';
import { TableauAvis } from '../../web/src/ecrans/TableauAvis.js';

afterEach(cleanup);
const texte = '<img src=x onerror=alert(1)>';
export const demande: Ask = {
  format: 'swairm-ask/1',
  id: '20261109T071500Z-3f2a',
  genere_a: '2026-11-09T07:15:00Z',
  prompt_version: '1',
  question: 'Question',
  sous_questions: [1, 2, 3, 4].map((n) => ({ n, texte: `Question ${n}` })),
  avis: ['ok', 'invalide', 'budget', 'echec', 'delai'].map((etat, i) => ({
    i: i + 1,
    modele_demande: 'sonnet',
    modele_servi: i === 0 ? 'modele-servi' : null,
    etat: etat as Ask['avis'][number]['etat'],
    cout_usd: null,
    duree_s: null,
    reponses: i === 0 ? [{ n: 1, verdict: 'oui', justification: texte }] : [],
    brut: etat === 'invalide' ? texte : null,
  })),
  accord: (['unanime', 'majorite', 'insuffisant', 'partage'] as const).map((accord, i) => ({
    n: i + 1,
    accord,
    verdict: null,
    compte: {},
  })),
  cout_total_usd: 0.12,
};
const resultat: AskResult<Ask> = { ok: true, data: demande, readAt: 't' };
test('tri des accords puis numéros, modèles, états et coût', async () => {
  render(<TableauAvis resultat={resultat} />);
  const numeros = () =>
    within(screen.getByRole('table'))
      .getAllByRole('rowheader')
      .map((e) => e.textContent?.slice(0, 1));
  expect(numeros()).toEqual(['4', '3', '2', '1']);
  await userEvent.selectOptions(screen.getByLabelText('Trier les sous-questions'), 'numeros');
  expect(numeros()).toEqual(['1', '2', '3', '4']);
  for (const texte of [
    'modele-servi — ok',
    'sonnet — Budget atteint',
    'sonnet — echec',
    'sonnet — delai',
    'Coût total : 0.12 USD',
  ])
    expect(screen.getByText(texte)).toBeTruthy();
  expect(screen.getAllByRole('columnheader').at(-1)?.textContent).toBe('Accord');
});
test('justification et brut restent du texte, sans image', async () => {
  render(<TableauAvis resultat={resultat} />);
  await userEvent.click(screen.getByText('Justification'));
  await userEvent.click(screen.getByText('Réponse brute'));
  expect(screen.getAllByText(texte)).toHaveLength(2);
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getAllByText(texte).every((e) => e.style.whiteSpace === 'pre-wrap')).toBe(true);
});
for (const [kind, message] of Object.entries({
  absent: 'Swairm absent',
  'too-old': 'Swairm trop ancien, ask manquant',
  timeout: 'Délai dépassé',
  annule: 'Annulé',
  format: 'Réponse illisible',
  unknown: 'Réponse illisible',
})) {
  test(`état ${kind}`, () => {
    render(<TableauAvis resultat={{ ok: false, kind, readAt: 't' } as AskResult<Ask>} />);
    expect(screen.getByRole('status').textContent).toBe(message);
  });
}
test('refus rendu tel quel', () => {
  render(<TableauAvis resultat={{ ok: false, kind: 'refusee', message: texte, readAt: 't' }} />);
  expect(screen.getByRole('status').textContent).toBe(`Question refusée : ${texte}`);
  expect(document.querySelector('img')).toBeNull();
});
test('aucun avis valide conserve le tableau et les états', () => {
  render(<TableauAvis resultat={{ ok: false, kind: 'aucun-avis', data: demande, readAt: 't' }} />);
  expect(screen.getByText('Aucun avis valide')).toBeTruthy();
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('sonnet — Budget atteint')).toBeTruthy();
});
