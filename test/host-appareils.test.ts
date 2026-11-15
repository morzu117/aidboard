import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import {
  DUREE_ACCES_MS,
  empreinte,
  GARDE_MS,
  nomAppareil,
  RegistreAppareils,
  TOUCHE_MS,
} from '../src/daemon/host/appareils.js';

// Chantier 31 (D177) : le registre des appareils, sur une vraie base, horloge injectée.

function registre(debut = Date.parse('2026-11-07T10:00:00Z')) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-ap-')), 'state.db'));
  const h = { t: debut };
  return { db, h, r: new RegistreAppareils(db, () => h.t) };
}

test('31.4 : un accès de 8 h exactement, sans prolongation par l’usage', () => {
  const { h, r } = registre();
  const { appareil, jeton } = r.emettre({ nom: 'Téléphone', identite: 'utilisateur@exemple' });
  expect(appareil.etat).toBe('actif');
  expect(Date.parse(appareil.expireA) - h.t).toBe(DUREE_ACCES_MS);
  h.t += DUREE_ACCES_MS - 1;
  const encore = r.authentifier(jeton);
  expect(encore.ok).toBe(true);
  // l'usage ne repousse jamais l'échéance
  expect(encore.ok && encore.appareil.expireA).toBe(appareil.expireA);
  h.t += 1;
  expect(r.authentifier(jeton)).toEqual({ ok: false, raison: 'expire' });
  expect(r.lire(appareil.id)!.etat).toBe('expire');
});

test('31.4 : seule l’empreinte est en base, jamais le jeton', () => {
  const { db, r } = registre();
  const { jeton } = r.emettre({ nom: 'Téléphone', identite: null });
  expect(jeton).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const lignes = JSON.stringify(db.prepare('SELECT * FROM appareils').all());
  expect(lignes).not.toContain(jeton);
  expect(lignes).toContain(empreinte(jeton));
  expect(JSON.stringify(r.lister())).not.toContain(jeton);
  expect(JSON.stringify(r.lister())).not.toContain(empreinte(jeton));
});

test('31.4 : un jeton inconnu, vide, trop court ou d’un autre type', () => {
  const { r } = registre();
  r.emettre({ nom: 'Téléphone', identite: null });
  for (const j of [
    'jeton-synthetique-inconnu-de-quarante-trois-car',
    '',
    'court',
    42,
    null,
    undefined,
  ]) {
    expect(r.authentifier(j), String(j)).toEqual({ ok: false, raison: 'inconnu' });
  }
});

test('31.4 : révoquer agit tout de suite, une fois ; le reste n’est pas touché', () => {
  const { r } = registre();
  const a = r.emettre({ nom: 'A', identite: null });
  const b = r.emettre({ nom: 'B', identite: null });
  expect(r.revoquer(a.appareil.id)).toBe(true);
  expect(r.revoquer(a.appareil.id)).toBe(false);
  expect(r.revoquer('ap_inconnu')).toBe(false);
  expect(r.authentifier(a.jeton)).toEqual({ ok: false, raison: 'revoque' });
  expect(r.authentifier(b.jeton).ok).toBe(true);
});

test('31.4 : couper tous les accès rend les appareils coupés, et seulement les actifs', () => {
  const { h, r } = registre();
  const vieux = r.emettre({ nom: 'Vieux', identite: null });
  h.t += DUREE_ACCES_MS; // expiré
  const a = r.emettre({ nom: 'A', identite: null });
  const b = r.emettre({ nom: 'B', identite: null });
  r.revoquer(b.appareil.id);
  const c = r.emettre({ nom: 'C', identite: null });
  expect(r.toutRevoquer().sort()).toEqual([a.appareil.id, c.appareil.id].sort());
  for (const j of [vieux.jeton, a.jeton, b.jeton, c.jeton])
    expect(r.authentifier(j).ok).toBe(false);
  expect(r.toutRevoquer()).toEqual([]);
});

test('31.4 : le dernier contact s’écrit au plus une fois par minute', () => {
  const { h, r } = registre();
  const { appareil, jeton } = r.emettre({ nom: 'A', identite: null });
  expect(appareil.dernierContact).toBeNull();
  const t0 = h.t;
  r.authentifier(jeton);
  h.t += TOUCHE_MS - 1;
  r.authentifier(jeton);
  expect(r.lire(appareil.id)!.dernierContact).toBe(new Date(t0).toISOString());
  h.t += 1;
  r.authentifier(jeton);
  expect(r.lire(appareil.id)!.dernierContact).toBe(new Date(h.t).toISOString());
});

test('31.4 : la liste, récents d’abord, avec l’état ; la purge à 30 jours', () => {
  const { h, r } = registre();
  const a = r.emettre({ nom: 'A', identite: 'utilisateur@exemple' });
  h.t += 1000;
  const b = r.emettre({ nom: 'B', identite: null });
  r.revoquer(a.appareil.id);
  expect(r.lister().map((x) => [x.nom, x.etat, x.identite])).toEqual([
    ['B', 'actif', null],
    ['A', 'revoque', 'utilisateur@exemple'],
  ]);
  h.t += GARDE_MS + 1;
  // A révoqué il y a plus de 30 jours, B expiré il y a moins de 30 jours + 8 h : A part, B reste
  expect(r.lister().map((x) => x.id)).toEqual([b.appareil.id]);
  h.t += DUREE_ACCES_MS;
  expect(r.lister()).toEqual([]);
});

test('31.4 : le nom proposé, nettoyé et borné', () => {
  expect(nomAppareil('  Mon iPhone  ')).toBe('Mon iPhone');
  expect(nomAppareil('a\u0000b‮c​d\nE')).toBe('abcdE');
  expect(nomAppareil('')).toBe('Appareil');
  expect(nomAppareil(42)).toBe('Appareil');
  expect([...nomAppareil('é'.repeat(100))]).toHaveLength(40);
  // gardé tel quel : jamais rendu en HTML, l'écran l'affiche en texte
  expect(nomAppareil('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
});
