import { expect, test } from 'vitest';
import {
  ALPHABET_CODE_COURT,
  Appairages,
  codeCourt,
  DUREE_CODE_MS,
  FENETRE_PLAFOND_MS,
  PLAFOND_RECLAMATIONS,
} from '../src/daemon/host/appairage.js';

// Chantier 31 (D176, lab M4 et DM 91366) : les demandes d'appairage, horloge injectée.

function appairages() {
  const h = { t: Date.parse('2026-11-07T10:00:00Z') };
  return { h, a: new Appairages(() => h.t) };
}
const appareil = (code: unknown, source = '100.64.0.2') => ({
  code,
  nom: 'Téléphone',
  identite: 'julien@exemple' as string | null,
  source,
});

test('31.4 : le parcours, de la création à la consommation, une seule fois', () => {
  const { a } = appairages();
  const d = a.creer();
  expect(d.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(d.id, 'base64url').length * 8).toBeGreaterThanOrEqual(128);
  const r = a.reclamer(appareil(d.code));
  if (!r.ok) throw new Error(r.raison);
  expect(r.demandeId).toBe(d.id);
  expect(r.codeCourt).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  expect(a.vueMac()).toMatchObject({
    etat: 'reclamee',
    codeCourt: r.codeCourt,
    nom: 'Téléphone',
    identite: 'julien@exemple',
  });
  expect(a.lirePourAppareil(d.id, r.jetonDemande)).toEqual({ etat: 'attente' });
  expect(a.approuver(d.id)).toEqual({ ok: true });
  expect(a.lirePourAppareil(d.id, r.jetonDemande)).toEqual({
    etat: 'approuvee',
    nom: 'Téléphone',
    identite: 'julien@exemple',
  });
  // consommée : la lecture suivante ne rend plus rien
  expect(a.lirePourAppareil(d.id, r.jetonDemande)).toEqual({ etat: 'inconnu' });
  expect(a.vueMac()!.etat).toBe('consommee');
  // le code ne sert plus
  expect(a.reclamer(appareil(d.code))).toEqual({ ok: false, raison: 'inconnu' });
});

test('31.4 (lab M4) : une seconde réclamation du même code annule la demande, pour les deux', () => {
  const { a } = appairages();
  const d = a.creer();
  const premier = a.reclamer(appareil(d.code, '100.64.0.2'));
  expect(premier.ok).toBe(true);
  expect(a.reclamer(appareil(d.code, '100.64.0.9'))).toEqual({ ok: false, raison: 'inconnu' });
  expect(a.vueMac()).toMatchObject({ etat: 'annulee', raison: 'deux-reclamations' });
  expect(a.approuver(d.id)).toEqual({ ok: false, raison: 'inconnu' });
  if (premier.ok)
    expect(a.lirePourAppareil(d.id, premier.jetonDemande)).toEqual({ etat: 'inconnu' });
});

test('31.4 (lab M4) : même après l’approbation, une seconde réclamation annule', () => {
  const { a } = appairages();
  const d = a.creer();
  const r = a.reclamer(appareil(d.code));
  a.approuver(d.id);
  a.reclamer(appareil(d.code, 'autre'));
  expect(a.vueMac()!.raison).toBe('deux-reclamations');
  if (r.ok) expect(a.lirePourAppareil(d.id, r.jetonDemande)).toEqual({ etat: 'inconnu' });
});

test('31.4 (DM 91366) : l’id seul, sans le jeton de demande ou avec un autre, n’ouvre rien', () => {
  const { a } = appairages();
  const d = a.creer();
  const r = a.reclamer(appareil(d.code));
  a.approuver(d.id);
  for (const j of [undefined, '', 'autre-jeton-synthetique', 42]) {
    expect(a.lirePourAppareil(d.id, j), String(j)).toEqual({ etat: 'inconnu' });
  }
  // et la demande reste à prendre par le bon appareil
  if (r.ok) expect(a.lirePourAppareil(d.id, r.jetonDemande).etat).toBe('approuvee');
});

test('31.4 (lab M4) : sans identité Tailscale, l’approbation demande la case', () => {
  const { a } = appairages();
  const d = a.creer();
  a.reclamer({ ...appareil(d.code), identite: null });
  expect(a.approuver(d.id)).toEqual({ ok: false, raison: 'identite-absente' });
  expect(a.vueMac()!.etat).toBe('reclamee');
  expect(a.approuver(d.id, { sansIdentite: true })).toEqual({ ok: true });
});

test('31.4 : approuver avant la réclamation, un autre id, deux fois : refusé', () => {
  const { a } = appairages();
  const d = a.creer();
  expect(a.approuver(d.id)).toEqual({ ok: false, raison: 'inconnu' });
  a.reclamer(appareil(d.code));
  expect(a.approuver('id-synthetique')).toEqual({ ok: false, raison: 'inconnu' });
  expect(a.approuver(d.id)).toEqual({ ok: true });
  expect(a.approuver(d.id)).toEqual({ ok: false, raison: 'inconnu' });
});

test('31.4 : le code expire à 5 minutes, réclamé ou non', () => {
  const { h, a } = appairages();
  let d = a.creer();
  h.t += DUREE_CODE_MS;
  expect(a.reclamer(appareil(d.code))).toEqual({ ok: false, raison: 'inconnu' });
  expect(a.vueMac()!.etat).toBe('expiree');
  d = a.creer();
  const r = a.reclamer(appareil(d.code));
  a.approuver(d.id);
  h.t += DUREE_CODE_MS;
  if (r.ok) expect(a.lirePourAppareil(d.id, r.jetonDemande)).toEqual({ etat: 'inconnu' });
});

test('31.4 : un nouveau code annule le précédent ; refuser et couper aussi', () => {
  const { a } = appairages();
  const d1 = a.creer();
  const d2 = a.creer();
  expect(a.reclamer(appareil(d1.code))).toEqual({ ok: false, raison: 'inconnu' });
  a.reclamer(appareil(d2.code));
  expect(a.refuser(d2.id)).toBe(true);
  expect(a.vueMac()).toMatchObject({ etat: 'annulee', raison: 'refusee' });
  expect(a.refuser(d2.id)).toBe(false);
  a.creer();
  a.toutAnnuler();
  expect(a.vueMac()).toMatchObject({ etat: 'annulee', raison: 'coupee' });
});

test('31.4 (lab M4) : 5 réclamations par minute et par source, puis 429', () => {
  const { h, a } = appairages();
  a.creer();
  for (let i = 0; i < PLAFOND_RECLAMATIONS; i++) {
    expect(a.reclamer(appareil('faux', 'S')).ok).toBe(false);
  }
  expect(a.reclamer(appareil('faux', 'S'))).toEqual({ ok: false, raison: 'plafond' });
  // une autre source n'est pas touchée ; même un code juste reste bloqué pour S
  const d = a.creer();
  expect(a.reclamer(appareil(d.code, 'S'))).toEqual({ ok: false, raison: 'plafond' });
  h.t += FENETRE_PLAFOND_MS;
  expect(a.reclamer(appareil(d.code, 'S')).ok).toBe(true);
});

test('31.4 : sans source, le seau est global', () => {
  const { a } = appairages();
  a.creer();
  for (let i = 0; i < PLAFOND_RECLAMATIONS; i++) a.reclamer(appareil('faux', ''));
  expect(a.reclamer(appareil('faux', ''))).toEqual({ ok: false, raison: 'plafond' });
  expect(a.reclamer(appareil('faux', 'global'))).toEqual({ ok: false, raison: 'plafond' });
});

test('31.4 : la vue du Mac ne porte ni le code ni le jeton de demande', () => {
  const { a } = appairages();
  const d = a.creer();
  const r = a.reclamer(appareil(d.code));
  const vue = JSON.stringify(a.vueMac());
  expect(vue).not.toContain(d.code);
  if (r.ok) expect(vue).not.toContain(r.jetonDemande);
});

test('31.4 : le code court, six caractères sans ambiguïté', () => {
  for (let i = 0; i < 200; i++) {
    const c = codeCourt();
    expect(c).toMatch(/^.{3}-.{3}$/);
    for (const ch of c.replace('-', '')) expect(ALPHABET_CODE_COURT).toContain(ch);
  }
  expect(ALPHABET_CODE_COURT).not.toMatch(/[01OIL]/);
});
