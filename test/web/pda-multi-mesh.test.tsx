// @vitest-environment jsdom
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AppPda } from '../../web/src/AppPda.js';
import * as pda from '../../web/src/data/pda.js';
import {
  CONTEXTE_DEMANDE,
  jsonCanonique,
  resumeAction,
  resumeActionMesh,
} from '../../src/shared/pda.js';

const paire = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = paire.publicKey.export({ format: 'jwk' });
const cle = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from(jwk.y!, 'base64url'),
]).toString('base64url');
const mesh = {
  nom: 'perso',
  cell: 'peer-a',
  gateway: 'A'.repeat(43),
  proxy: Buffer.alloc(32, 1).toString('base64url'),
};
const params = {
  action: 'dm.envoyer',
  params: { pair: 'peer-a', fil: null, kind: 'fyi', texte: 'Bonjour' },
} as const;
function corps(v = 3) {
  return {
    v,
    id: Buffer.alloc(16, 1).toString('base64url'),
    action: 'mesh.ecrire',
    classe: 'toujours',
    params,
    resume:
      v === 3 ? resumeActionMesh(mesh, 'mesh.ecrire', params) : resumeAction('mesh.ecrire', params),
    numero: null,
    emise: Date.now(),
    echeance: Date.now() + 300000,
    ...(v === 3 ? { mesh } : {}),
  };
}
function enveloppe(c: unknown) {
  const octets = Buffer.from(jsonCanonique(c));
  return {
    corps: octets.toString('base64url'),
    sig: sign('sha256', Buffer.concat([Buffer.from(CONTEXTE_DEMANDE), octets]), {
      key: paire.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  };
}
async function afficher(liste: unknown[]) {
  vi.stubGlobal('crypto', webcrypto);
  window.history.replaceState(null, '', '/pda');
  vi.spyOn(pda, 'chargerCodePda').mockResolvedValue({
    CLE_DAEMON: cle,
    RELAIS: 'https://example.com',
  });
  vi.spyOn(pda, 'stockagePda').mockResolvedValue({
    id: 'test',
    credId: 'AQ',
    cleRelais: {} as CryptoKey,
  });
  vi.spyOn(pda, 'requeteRelais').mockImplementation(
    async () => new Response(JSON.stringify(liste)),
  );
  vi.spyOn(pda, 'lireResultats').mockResolvedValue([]);
  vi.spyOn(pda, 'fabriquerReponse').mockResolvedValue(
    {} as Awaited<ReturnType<typeof pda.fabriquerReponse>>,
  );
  return render(<AppPda />);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([2, 3])('invite v%s : bandeau avant le résumé, sans empreintes', async (v) => {
  const c = corps(v);
  const vue = await afficher([enveloppe(c)]);
  const titre = await screen.findByRole('heading', { name: c.resume });
  const bandeau = screen.getByText(
    v === 3 ? 'Mesh : perso' : 'Mesh : principal (demande d’avant le multi-mesh)',
  );
  expect(bandeau.compareDocumentPosition(titre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  if (v === 3) expect(vue.container.textContent).toContain('cell peer-a');
  expect(vue.container.textContent).not.toContain(mesh.gateway);
  expect(vue.container.textContent).not.toContain(mesh.proxy);
});

test('action hors mesh : aucun bandeau', async () => {
  const c = {
    ...corps(2),
    action: 'desarmement',
    params: {},
    resume: resumeAction('desarmement', {}),
  };
  await afficher([enveloppe(c)]);
  await screen.findByRole('heading', { name: c.resume });
  expect(screen.queryByText(/Mesh :/)).toBeNull();
});

test.each(['absent', 'nom', 'signature'])(
  'v3 %s invalide : jamais affichée par le vrai lecteur',
  async (cas) => {
    const c = corps();
    const invalide =
      cas === 'absent'
        ? { ...c, mesh: undefined }
        : cas === 'nom'
          ? { ...c, mesh: { ...mesh, nom: 'INVALIDE' } }
          : c;
    const e = enveloppe(
      cas === 'absent'
        ? Object.fromEntries(Object.entries(invalide).filter(([k]) => k !== 'mesh'))
        : invalide,
    );
    if (cas === 'signature') e.sig = Buffer.alloc(64).toString('base64url');
    await afficher([e]);
    await screen.findByText('demande illisible ignorée', { exact: false });
    expect(screen.queryByRole('heading', { name: c.resume })).toBeNull();
    expect(screen.queryByText(/Mesh :/)).toBeNull();
  },
);

test('réponses récentes : conserve le résumé v3', async () => {
  const c = corps();
  await afficher([enveloppe(c)]);
  const champ = await screen.findByLabelText('Retape le numéro affiché sur le Mac');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Actualiser' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(champ, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Réponse envoyée');
  expect(screen.getByText(c.resume).tagName).toBe('P');
  expect(screen.queryByText('Demande d’essai')).toBeNull();
});
