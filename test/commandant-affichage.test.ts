import { expect, it } from 'vitest';
import {
  ageCommandant,
  CODES_REFUS_COMMANDANT,
  HTTP_REFUS_COMMANDANT,
  CONSIGNE_IDENTIFIANT_COMMANDANT,
  identifiantCommandantARefaire,
  libelleReponseCommandant,
  messageErreurCommandant,
} from '../src/shared/commandant-reponse.js';

it.each([
  [3 * 60_000, 'il y a 3 min'],
  [4 * 3_600_000, 'il y a 4 h'],
  [2 * 86_400_000, 'il y a 2 j'],
  [-1000, 'il y a 0 min'],
])('rend un âge lisible pour %i ms', (duree, attendu) => {
  expect(ageCommandant(0, duree as number)).toBe(attendu);
});
it('porte les deux messages exacts de la relecture', () => {
  expect(messageErreurCommandant('not_pending')).toBe(
    'La demande a déjà reçu une réponse ailleurs (409 not_pending).',
  );
  expect(messageErreurCommandant('digest_mismatch')).toBe(
    'La demande a changé côté passerelle : relis-la (409 digest_mismatch).',
  );
});
it.each(CODES_REFUS_COMMANDANT)('explique %s en français avec le code à la fin', (code) => {
  const message = libelleReponseCommandant('echouee', code);
  expect(message.endsWith(` (${HTTP_REFUS_COMMANDANT[code]} ${code}).`)).toBe(true);
  expect(message.split(' (')[0]!.length).toBeGreaterThan(30);
  expect(message).not.toContain('Refusé par la passerelle :');
  if (identifiantCommandantARefaire(code))
    expect(message).toBe(`${CONSIGNE_IDENTIFIANT_COMMANDANT} (401 ${code}).`);
});
it.each([
  'commandant_parametres',
  'commandant_bad_answer',
  'commandant_type',
  'commandant_not_pending',
  'commandant_needs_sso',
  'commandant_limites',
  'commandant_digest_mismatch',
  'commandant_indisponible',
  'commandant_illisible_digest',
  'commandant_illisible_summary',
  'commandant_illisible_forme',
  'commandant_illisible_why',
  'commandant_illisible_question',
  'commandant_illisible_options',
  'commandant_illisible_head_sha',
  'commandant_illisible_needs_sso',
  'commandant_illisible_statut',
  'commandant_illisible_date',
  'commandant_delai',
  'commandant_reseau',
  'commandant_identifiant',
  'confirmation_requise',
  'confirmation_impossible',
  'demande_trop_grande',
])('explique le refus de préparation %s sans message distant', (code) => {
  expect(messageErreurCommandant(code, 409).endsWith(` (409 ${code}).`)).toBe(true);
});
it.each(['delai', 'taille', 'reseau', 'json', 'http', 'gateway', 'identifiant', 'requete'])(
  'explique l’erreur de lecture %s',
  (code) => expect(messageErreurCommandant(code).endsWith(` (${code}).`)).toBe(true),
);
it('ne réfléchit pas un code distant inconnu', () => {
  expect(messageErreurCommandant('CONTENU_DISTANT', 500)).toBe(
    'Lecture ou réponse impossible (HTTP 500).',
  );
});

it('explique le rendu inattendu après un envoi accepté, sur le Mac comme sur le PDA', () => {
  expect(libelleReponseCommandant('echouee', 'envoyee_rendu_inattendu')).toBe(
    "La passerelle a accepté l'envoi, mais sa réponse ne correspond pas : la réponse est peut-être enregistrée. Relis la demande avant de recommencer.",
  );
});
