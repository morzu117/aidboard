import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { migrate } from '../src/daemon/db.js';
import { registerConfirmationRoutes } from '../src/daemon/routes/confirmations.js';
import type { Porte } from '../src/daemon/confirmations/porte.js';

test('GET confirmations : projection du mesh en base, sans empreintes, ouverte et récente', async () => {
  const db = new Database(':memory:');
  const app = Fastify();
  try {
    migrate(db);
    app.addHook('onRequest', async (req) => {
      req.principal = { kind: 'admin', via: 'cookie' } as typeof req.principal;
    });
    registerConfirmationRoutes(app, db, {} as Porte, () => null);
    const inserer = db.prepare(
      `INSERT INTO pda_demandes (id, action, sujet, h_demande, numero, echeance, etat, cree_a, mesh) VALUES (?, 'mesh.ecrire', 'test', 'hash', '1234', 100, ?, 'date', ?)`,
    );
    const mesh = {
      nom: 'perso',
      cell: 'peer-a',
      gateway: 'empreinte-gateway',
      proxy: 'empreinte-proxy',
    };
    inserer.run('ouverte', 'ouverte', JSON.stringify(mesh));
    inserer.run('recente', 'expiree', JSON.stringify(mesh));
    inserer.run('ancienne', 'ouverte', null);
    inserer.run('illisible', 'ouverte', '{');
    const reponse = await app.inject('/api/confirmations');
    expect(reponse.statusCode).toBe(200);
    const liste = reponse.json();
    for (const d of [...liste.ouvertes, ...liste.recentes]) {
      expect(d.mesh).toEqual(
        ['ancienne', 'illisible'].includes(d.id) ? null : { nom: 'perso', cell: 'peer-a' },
      );
    }
    expect(reponse.body).not.toMatch(/empreinte|gateway|proxy/);
  } finally {
    await app.close();
    db.close();
  }
});
