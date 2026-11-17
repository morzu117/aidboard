import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { envoyer } from '../src/daemon/push/envoi.js';
import { notifierCommandant } from '../src/daemon/push/commandant.js';
import { migrate } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';

it('le vrai transport chiffre seulement {c:id} et garde le compteur {n} intact', async () => {
  const abonne = createECDH('prime256v1');
  abonne.generateKeys();
  const secret = Buffer.alloc(16, 3);
  const abonnement = {
    endpoint: 'https://fcm.googleapis.com/exemple',
    p256dh: abonne.getPublicKey().toString('base64url'),
    auth: secret.toString('base64url'),
  };
  const charges: unknown[] = [];
  const transport = async (_url: URL, options: RequestInit) => {
    const corps = Buffer.from(options.body as Uint8Array);
    const serveur = corps.subarray(21, 86);
    const materiel = hkdfSync(
      'sha256',
      abonne.computeSecret(serveur),
      secret,
      Buffer.concat([Buffer.from('WebPush: info\0'), abonne.getPublicKey(), serveur]),
      32,
    );
    const cle = hkdfSync(
      'sha256',
      Buffer.from(materiel),
      corps.subarray(0, 16),
      Buffer.from('Content-Encoding: aes128gcm\0'),
      16,
    );
    const nonce = hkdfSync(
      'sha256',
      Buffer.from(materiel),
      corps.subarray(0, 16),
      Buffer.from('Content-Encoding: nonce\0'),
      12,
    );
    const dechiffreur = createDecipheriv('aes-128-gcm', Buffer.from(cle), Buffer.from(nonce));
    dechiffreur.setAuthTag(corps.subarray(-16));
    const rempli = Buffer.concat([
      dechiffreur.update(corps.subarray(86, -16)),
      dechiffreur.final(),
    ]);
    let fin = rempli.length - 1;
    while (rempli[fin] === 0) fin--;
    expect(rempli[fin]).toBe(2);
    charges.push(JSON.parse(rempli.subarray(0, fin).toString()));
    return { status: 201, body: null };
  };
  const deps = {
    transport,
    clesVapid: {
      clePubliqueBase64url: () => '',
      jetonVapid: () => '',
      enTeteAuthorization: () => '',
    },
  };
  await envoyer(abonnement, { c: 1234 }, deps);
  await envoyer(abonnement, 2, deps);
  expect(charges).toEqual([{ c: 1234 }, { n: 2 }]);
});
it('le déclencheur respecte push désactivé, nettoie un abonnement expiré et émet seulement son statut', async () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const store = new EventStore(db);
    const registre = new RegistreAppareils(db);
    const { appareil } = registre.emettre({ nom: 'Téléphone test', identite: null });
    db.prepare('INSERT INTO push_abonnements VALUES (?, ?, ?, ?, ?)').run(
      appareil.id,
      'https://example.com/push',
      'cle',
      'auth',
      new Date().toISOString(),
    );
    const expedier = vi.fn<typeof envoyer>(async () => ({ statut: 'expire' }));
    const deps = {
      db,
      store,
      actif: () => false,
      envoyer: expedier,
      envoi: () => ({
        clesVapid: {
          clePubliqueBase64url: () => '',
          jetonVapid: () => '',
          enTeteAuthorization: () => '',
        },
      }),
    };
    await notifierCommandant(1234, deps);
    expect(expedier).not.toHaveBeenCalled();
    await notifierCommandant(1234, { ...deps, actif: () => true });
    expect(expedier.mock.calls[0]![1]).toEqual({ c: 1234 });
    expect(db.prepare('SELECT * FROM push_abonnements').all()).toEqual([]);
    expect(
      store
        .since(null)
        .filter((e) => e.type === 'push.envoye')
        .map((e) => e.data),
    ).toEqual([{ appareilId: appareil.id, statut: 'expire' }]);
  } finally {
    db.close();
  }
});
