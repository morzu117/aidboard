import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

it.each([
  'key={agent.id}',
  'DB_PASSWORD=${DB_PASS}',
  'token={{ secret.DEV }}',
  'DB_PASSWORD=$DB_PASS',
  'token: ${{ secrets.X }}',
  'token=%(dev_token)s',
  '"token": "$DEV_TOKEN"',
])('accepte une référence dans une affectation de secret (%s)', (texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

it.each(['omit', 'include', 'same-origin'])(
  'accepte le mode Fetch %s pour credentials seulement',
  (mode) => {
    expect(nettoyer(`credentials: '${mode}'`)).toEqual({ ok: true });
    expect(nettoyer(`service_credentials: '${mode}'`)).toEqual({
      ok: false,
      classe: 'ressemble à une clé API',
    });
    expect(nettoyer(`token=${mode}`)).toEqual({
      ok: false,
      classe: 'ressemble à une clé API',
    });
  },
);

it.each([
  'key={agent.id} DB_PASSWORD=hunter22',
  'token: ${{ secrets.X }} DB_PASSWORD=hunter22',
  'password=$DB_PASS',
  'absence de token : refusée',
])('refuse toujours une affectation détectée (%s)', (texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});
