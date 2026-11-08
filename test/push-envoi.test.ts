import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envoyer, HOTES_PUSH, TOPIC, verifierEndpoint } from '../src/daemon/push/envoi.js';
import { TAILLE_CLAIR } from '../src/daemon/push/chiffre.js';

const endpoint = 'https://fcm.googleapis.com/endpoint-marqueur-confidentiel';
const abonne = createECDH('prime256v1');
abonne.generateKeys();
const abonnement = {
  endpoint,
  p256dh: abonne.getPublicKey().toString('base64url'),
  auth: Buffer.alloc(16, 1).toString('base64url'),
};
const clesVapid = {
  clePubliqueBase64url: () => 'publique-test',
  jetonVapid: () => 'jeton-test',
  enTeteAuthorization: vi.fn(() => 'vapid t=jeton-test, k=publique-test'),
};

afterEach(() => vi.restoreAllMocks());

describe('verifierEndpoint', () => {
  it.each([
    'http://fcm.googleapis.com/x',
    'https://user@fcm.googleapis.com/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://web.push.apple.com.evil.example/x',
    'https://evilweb.push.apple.com/x',
    'https://fcm.googleapis.com./x',
    'https://192.0.2.1/x',
    'https://[::1]/x',
    'https://127.0.0.1/x',
    'https://fсm.googleapis.com/x', // Le с est cyrillique.
    'https://wns2-par02p.notify.windows.com/x',
    'javascript:',
    'file:',
    '',
  ])('refuse %s', (url) => expect(verifierEndpoint(url)).toBeNull());

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/x',
    'https://web.push.apple.com/Qabc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://a.web.push.apple.com/x',
    'https://FCM.GOOGLEAPIS.COM/x',
  ])('accepte %s', (url) => expect(verifierEndpoint(url)).toBeInstanceOf(URL));

  it('fige la liste fermée', () => {
    expect(Object.isFrozen(HOTES_PUSH)).toBe(true);
    expect(HOTES_PUSH).toHaveLength(3);
  });
});

describe('envoyer', () => {
  it('envoie les en-têtes exacts et un corps de taille fixe', async () => {
    const annuler = vi.fn(async () => {});
    const transport = vi.fn(async () => ({
      status: 201,
      body: { cancel: annuler } as unknown as Response['body'],
    }));
    const deps = { transport, clesVapid, maintenant: () => 1234 };
    await expect(envoyer(abonnement, 1, deps)).resolves.toEqual({ statut: 'ok', code: 201 });
    await envoyer(abonnement, 123456, deps);
    for (const appel of transport.mock.calls as unknown as [URL, RequestInit][]) {
      expect(appel[0].href).toBe(endpoint);
      expect(appel[1]).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '300',
          Urgency: 'high',
          Topic: TOPIC,
          Authorization: 'vapid t=jeton-test, k=publique-test',
        },
      });
      expect(appel[1].body).toBeInstanceOf(Uint8Array);
      expect((appel[1].body as Uint8Array).length).toBe(86 + TAILLE_CLAIR + 1 + 16);
      expect(Buffer.from(appel[1].body as Uint8Array).includes(Buffer.from('{"n":'))).toBe(false);
    }
    expect(clesVapid.enTeteAuthorization).toHaveBeenCalledWith(endpoint, 1234);
    expect(annuler).toHaveBeenCalledTimes(2);
    expect(TOPIC).toBe('aid');
  });

  it.each([
    [201, 'ok'],
    [204, 'ok'],
    [404, 'expire'],
    [410, 'expire'],
    [301, 'echec'],
    [302, 'echec'],
    [400, 'echec'],
    [500, 'echec'],
  ])('classe le code %i sans nouvel appel', async (code, statut) => {
    const transport = vi.fn(async () => ({ status: code, body: null }));
    await expect(envoyer(abonnement, 1, { transport, clesVapid })).resolves.toEqual({
      statut,
      code,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('applique le délai de dix secondes', async () => {
    const delai = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    const transport = vi.fn(async (_url: URL, options: RequestInit) => {
      options.signal?.throwIfAborted();
      return { status: 201, body: null };
    });
    await expect(envoyer(abonnement, 1, { transport, clesVapid })).resolves.toEqual({
      statut: 'echec',
    });
    expect(delai).toHaveBeenCalledWith(10_000);
  });

  it('refuse un endpoint avant tout transport', async () => {
    const transport = vi.fn();
    await expect(
      envoyer({ ...abonnement, endpoint: 'https://example.com/x' }, 1, { transport, clesVapid }),
    ).resolves.toEqual({ statut: 'echec' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('ne propage ni ne journalise un endpoint présent dans une erreur réseau', async () => {
    const journaux = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const espions = journaux.map((nom) => vi.spyOn(console, nom).mockImplementation(() => {}));
    const transport = vi.fn(async () => {
      throw new Error(endpoint);
    });
    const resultat = await envoyer(abonnement, 1, { transport, clesVapid });
    expect(resultat).toEqual({ statut: 'echec' });
    expect(JSON.stringify(resultat)).not.toContain(endpoint);
    for (const espion of espions) expect(espion).not.toHaveBeenCalled();
  });
});
