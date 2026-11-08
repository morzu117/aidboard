import { sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { creerRelais } from '../src/relais/index.js';
import { ClientRelais } from '../src/daemon/pda/relais.js';
import { FilePda } from '../src/daemon/pda/file.js';
import { hacher, octetsRequeteRelais, signatureBasse } from '../src/shared/pda.js';
import { assertionPda, preparerPda } from './helpers/pda.js';

test('vrai relais : liste, dépôt, assertion signée, tirage et 50 signatures basses acceptées', async () => {
  const t = preparerPda();
  const a = await t.appareil();
  let heure = 1_800_000_000_000;
  const journalRelais = vi.fn();
  const serveur = createServer(
    creerRelais({
      origineApp: 'https://aid-e2e.ts.net',
      cleDaemon: t.fournisseur.clePubliqueRaw(),
      now: () => heure,
      journal: journalRelais,
    }),
  );
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  const transport = vi.fn(async (url: URL, options: RequestInit) =>
    fetch(new URL(url.pathname + url.search, base), options),
  );
  const client = new ClientRelais({
    relais: 'https://example.com',
    fournisseur: t.fournisseur,
    journal: t.journal,
    maintenant: () => heure,
    transport,
  });
  const file = new FilePda({
    ...t,
    relais: client,
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    maintenant: () => heure,
    signaler: () => {},
  });
  try {
    const { id } = await file.creerDemande({ action: 'essai', sujet: 'Exemple' });
    const corps = JSON.stringify(await assertionPda(t.db, id, a));
    const chemin = `/reponses/${id}`;
    const instant = String(++heure);
    const signature = signatureBasse(
      sign(
        'sha256',
        octetsRequeteRelais({
          methode: 'POST',
          chemin,
          hachageCorps: await hacher(Buffer.from(corps)),
          heure: instant,
        }),
        { key: a.relais, dsaEncoding: 'ieee-p1363' },
      ),
    );
    const reponse = await fetch(base + chemin, {
      method: 'POST',
      headers: {
        Origin: 'https://aid-e2e.ts.net',
        'X-Aid-Appareil': a.id,
        'X-Aid-Heure': instant,
        'X-Aid-Sig': Buffer.from(signature).toString('base64url'),
      },
      body: corps,
    });
    expect(reponse.status).toBe(204);
    await file.tour();
    expect(file.etat(id)).toEqual({ etat: 'confirmee' });
    expect(t.journal).toHaveBeenCalledWith('pda.essai', { id, valeur: 'oui' });
    for (let i = 0; i < 50; i++) await client.publierAutorises([]);
    const daemon = journalRelais.mock.calls
      .map(([e]) => e)
      .filter(
        (e) => e.route === '/autorises' || e.route === '/demandes/:id' || e.route === '/reponses',
      );
    expect(daemon.length).toBeGreaterThanOrEqual(54);
    expect(daemon.every((e) => e.statut >= 200 && e.statut < 300)).toBe(true);
    expect(t.journal).not.toHaveBeenCalledWith('pda.relais.echec');
    expect(transport.mock.calls.every(([url]) => url.origin === 'https://example.com')).toBe(true);
  } finally {
    await file.arreter();
    await new Promise<void>((r, rej) => serveur.close((e) => (e ? rej(e) : r())));
    t.nettoyer();
  }
});
