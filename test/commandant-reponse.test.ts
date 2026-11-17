import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { creerActionCommandant } from '../src/daemon/confirmations/commandant.js';
import type { ContexteAction } from '../src/daemon/confirmations/porte.js';
import { ServiceCommandant } from '../src/daemon/commandant/service.js';
import {
  controlerLigneCommandant,
  digestCommandant,
  type LigneCommandant,
} from '../src/shared/commandant.js';
import { CLASSE_ACTION, resumeAction, validerParamsAction } from '../src/shared/confirmations.js';
import { CODES_REFUS_COMMANDANT, HTTP_REFUS_COMMANDANT } from '../src/shared/commandant-reponse.js';
import { signerResultat, verifierResultat } from '../src/shared/pda.js';
import { sign } from 'node:crypto';
import { preparerPda } from './helpers/pda.js';
import {
  creerPasserelleCommandant,
  IDENTIFIANT_COCKPIT_TEST,
  ligneCommandantTest,
} from './fixtures/passerelle-commandant.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
async function preparer() {
  const home = mkdtempSync(join(tmpdir(), 'aid-reponse-commandant-'));
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const faux = await creerPasserelleCommandant();
  nettoyages.push(() => faux.fermer());
  const notifier = vi.fn(async () => {});
  const service = new ServiceCommandant({
    home,
    meshes: () => ({ principal: { cell: 'cell-lab', gateway: faux.url } }),
    notifier,
  });
  nettoyages.push(() => service.arreter());
  await service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  const action = creerActionCommandant(service);
  const ctx: ContexteAction = { confirmation: true, mesh: 'principal' };
  const entree = {
    mesh: 'principal',
    params: { requestId: 1235, digest: faux.lignes.get(1235)!.digest, decision: 'oui' },
  };
  return { home, faux, service, action, ctx, entree, notifier };
}
it('signe les copies contrôlées, ne signe jamais le secret et répond seulement après confirmation', async () => {
  const t = await preparer();
  const p = await t.action.preparer(t.entree, t.ctx);
  expect(p).toEqual({
    mesh: 'principal',
    requestId: 1235,
    type: 'decision',
    digest: t.entree.params.digest,
    decision: 'oui',
    question: 'Activer le cockpit de test ?',
    options: ['oui', 'non'],
  });
  expect(CLASSE_ACTION['mesh.commandant.repondre']).toBe('toujours');
  expect(resumeAction('mesh.commandant.repondre', p)).toBe('Demande #1235 : oui');
  expect(JSON.stringify(p)).not.toContain(IDENTIFIANT_COCKPIT_TEST);
  await expect(t.action.executer(p, { ...t.ctx, confirmation: false })).rejects.toThrow(
    'confirmation_requise',
  );
  expect(t.faux.appels.filter((a) => a.methode === 'POST')).toHaveLength(0);
  await t.action.executer(p, t.ctx);
  expect(t.ctx.envoi).toEqual({ code: 'succes', open_obligations: [] });
  expect(t.faux.appels.at(-1)!.corps).toEqual({
    decision: 'answer',
    answer: 'oui',
    digest: p.digest,
  });
  expect(t.faux.lignes.get(1235)).toMatchObject({ status: 'answered', decided_via: 'cockpit' });
  expect(JSON.stringify(t.ctx)).not.toContain(IDENTIFIANT_COCKPIT_TEST);
});
const refus: Array<[string, (v: LigneCommandant) => void, string]> = [
  [
    'digest illisible',
    (v) => {
      v.digest = '0'.repeat(64);
    },
    'commandant_illisible_digest',
  ],
  [
    'résumé illisible',
    (v) => {
      v.summary = ['x'.repeat(121)];
    },
    'commandant_illisible_summary',
  ],
  [
    'action',
    (v) => {
      Object.assign(v, ligneCommandantTest(1235, 'merge_pr'));
    },
    'commandant_type',
  ],
  [
    'close',
    (v) => {
      v.status = 'answered';
    },
    'commandant_not_pending',
  ],
  [
    'SSO',
    (v) => {
      v.params.needs_sso = true;
      v.needs_sso = true;
      v.digest = digestCommandant(v);
    },
    'commandant_needs_sso',
  ],
  [
    'limites',
    (v) => {
      v.params.question = 'x'.repeat(361);
      v.question = v.params.question;
      v.digest = digestCommandant(v);
    },
    'commandant_limites',
  ],
  [
    'digest changé',
    (v) => {
      v.params.question = 'Autre question';
      v.question = v.params.question;
      v.digest = digestCommandant(v);
    },
    'commandant_digest_mismatch',
  ],
];
it.each(refus)('preparer refuse %s sans decide', async (_nom, changer, code) => {
  const t = await preparer();
  // Transport fidèle à la ligne brute pour jouer un résumé ou digest mal formé.
  const original = t.service.relireDetail.bind(t.service);
  vi.spyOn(t.service, 'relireDetail').mockImplementation(async (mesh, id) => {
    const c = await original(mesh, id);
    if ('valide' in c && c.valide) {
      changer(c.ligne);
      const { controlerLigneCommandant } = await import('../src/shared/commandant.js');
      return controlerLigneCommandant(c.ligne);
    }
    return c;
  });
  await expect(t.action.preparer(t.entree, t.ctx)).rejects.toThrow(code);
  expect(t.faux.appels.filter((a) => a.methode === 'POST')).toHaveLength(0);
});
it('preparer refuse une lecture impossible et une option absente', async () => {
  const t = await preparer();
  await expect(
    t.action.preparer({ ...t.entree, params: { ...t.entree.params, decision: 'autre' } }, t.ctx),
  ).rejects.toThrow('commandant_bad_answer');
  t.faux.lignes.delete(1235);
  await expect(t.action.preparer(t.entree, t.ctx)).rejects.toThrow('commandant_not_found');
});
it.each(['', '   ', 'x'.repeat(1001), 'x\u200b', 'x\ny'])(
  'refuse le texte libre hors règle (%s)',
  async (decision) => {
    const t = await preparer();
    const v = ligneCommandantTest(1235, 'decision', { question: 'Question libre ?', options: [] });
    t.faux.lignes.set(1235, v);
    await expect(
      t.action.preparer(
        { mesh: 'principal', params: { requestId: 1235, digest: v.digest, decision } },
        t.ctx,
      ),
    ).rejects.toThrow('commandant_bad_answer');
  },
);
it('accepte 1 000 caractères Unicode en texte libre', async () => {
  const t = await preparer();
  const v = ligneCommandantTest(1235, 'decision', { question: 'Question libre ?', options: [] });
  t.faux.lignes.set(1235, v);
  const p = await t.action.preparer(
    {
      mesh: 'principal',
      params: { requestId: 1235, digest: v.digest, decision: '😀'.repeat(1000) },
    },
    t.ctx,
  );
  await t.action.executer(p, t.ctx);
  expect(t.ctx.envoi?.code).toBe('succes');
});
it.each(['digest', 'statut', 'type', 'sso', 'question', 'options'])(
  'executer refuse la ligne périmée (%s), sans decide',
  async (cas) => {
    const t = await preparer();
    const p = await t.action.preparer(t.entree, t.ctx);
    const v = t.faux.lignes.get(1235)!;
    if (cas === 'digest') v.params.autre = true;
    if (cas === 'statut') v.status = 'answered';
    if (cas === 'type') Object.assign(v, ligneCommandantTest(1235, 'merge_pr'));
    if (cas === 'sso') {
      v.params.needs_sso = true;
      v.needs_sso = true;
    }
    if (cas === 'question') {
      v.params.question = 'Autre ?';
      v.question = 'Autre ?';
    }
    if (cas === 'options') {
      v.params.options = ['autre'];
      v.options = ['autre'];
    }
    await expect(t.action.executer(p, t.ctx)).rejects.toThrow('perime');
    expect(t.faux.appels.filter((a) => a.methode === 'POST')).toHaveLength(0);
  },
);
it.each(CODES_REFUS_COMMANDANT)(
  'garde le refus typé %s dans le résultat signé, sans corps distant',
  async (code) => {
    const t = await preparer();
    const p = await t.action.preparer(t.entree, t.ctx);
    const http = HTTP_REFUS_COMMANDANT[code];
    t.faux.scenario.erreurDecide = {
      http,
      corps:
        code === 'champ_requis'
          ? {
              detail: [
                {
                  loc: ['body', 'answer'],
                  input: IDENTIFIANT_COCKPIT_TEST,
                  msg: IDENTIFIANT_COCKPIT_TEST,
                },
              ],
            }
          : {
              error: code,
              ...(code === 'not_pending' ? { status: 'answered' } : {}),
              prive: IDENTIFIANT_COCKPIT_TEST,
            },
    };
    await t.action.executer(p, t.ctx);
    expect(t.ctx.envoi).toEqual({ code, status: http, open_obligations: [] });
    if (http === 401)
      expect(t.service.etat('principal').identifiant.etat).toBe(
        code.endsWith('unknown') ? 'inconnu' : code.endsWith('revoked') ? 'revoque' : 'expire',
      );
    const cle = preparerPda();
    nettoyages.push(cle.nettoyer);
    const enveloppe = signerResultat(
      {
        v: 1,
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        action: 'mesh.commandant.repondre',
        resultat: 'echouee',
        raison: null,
        code: t.ctx.envoi!.code,
        emis: Date.now(),
      },
      (octets) =>
        sign('sha256', octets, { key: cle.fournisseur.obtenir(), dsaEncoding: 'ieee-p1363' }),
    );
    expect(enveloppe).not.toBeNull();
    const resultat = await verifierResultat(enveloppe!, cle.fournisseur.clePubliqueRaw());
    expect(resultat?.code).toBe(code);
    expect(JSON.stringify({ resultat, ctx: t.ctx, journal: cle.journal.mock.calls })).not.toContain(
      IDENTIFIANT_COCKPIT_TEST,
    );
  },
);
it.each(['sso', 'statut', 'digest', 'id', 'answer'])(
  'ne dit pas répondu sur un succès invalide (%s)',
  async (cas) => {
    const t = await preparer();
    const p = await t.action.preparer(t.entree, t.ctx);
    t.faux.scenario.apresDecide = (v) => {
      if (cas === 'answer') v.answer = 'autre';
      if (cas === 'sso') v.decided_via = 'sso';
      if (cas === 'statut') v.status = 'pending';
      if (cas === 'digest') v.params.question = 'Autre ?';
      if (cas === 'id') v.id++;
    };
    await t.action.executer(p, t.ctx);
    expect(t.ctx.envoi?.code).toBe('envoyee_rendu_inattendu');
  },
);
it('ferme le schéma signé aux clés supplémentaires et aux caractères interdits', async () => {
  const t = await preparer();
  const p = await t.action.preparer(t.entree, t.ctx);
  for (const changement of [
    { secret: 'x' },
    { type: 'merge_pr' },
    { digest: 'a'.repeat(16) },
    { requestId: '1235' },
    { options: ['oui', '\u200b'] },
    { question: '\n' },
    { decision: 'autre' },
    { mesh: '../autre' },
  ])
    expect(validerParamsAction('mesh.commandant.repondre', { ...p, ...changement })).toBe(false);
});

it('la route Mac ouvre uniquement une demande de la porte, avec son mesh et son digest', async () => {
  const t = await preparer();
  const { default: Fastify } = await import('fastify');
  const { registerCommandantRoutes } = await import('../src/daemon/routes/commandant.js');
  const demander = vi.fn(async () => ({ confirmation: 'demande-test' }));
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-admin-test'] === '1') req.principal = { kind: 'admin', via: 'cookie' };
  });
  registerCommandantRoutes(app, t.service, true, {
    demander,
  } as unknown as import('../src/daemon/confirmations/porte.js').Porte);
  const url = '/api/commandant/principal/demandes/1235/reponse';
  const payload = { digest: t.entree.params.digest, decision: 'oui' };
  expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403);
  for (const corps of [
    { ...payload, digest: 'a'.repeat(16) },
    { ...payload, decision: 1 },
    { ...payload, autre: true },
  ])
    expect(
      (await app.inject({ method: 'POST', url, payload: corps, headers: { 'x-admin-test': '1' } }))
        .statusCode,
    ).toBe(400);
  expect(demander).not.toHaveBeenCalled();
  const r = await app.inject({ method: 'POST', url, payload, headers: { 'x-admin-test': '1' } });
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ confirmation: 'demande-test' });
  expect(demander).toHaveBeenCalledWith(
    'mesh.commandant.repondre',
    { mesh: 'principal', params: { requestId: 1235, ...payload } },
    expect.anything(),
  );
  expect(t.faux.appels.filter((a) => a.methode === 'POST')).toHaveLength(0);
});

it('conserve exactement une option signée, sans appliquer le trim réservé au texte libre', async () => {
  const t = await preparer();
  const v = ligneCommandantTest(1235, 'decision', {
    question: 'Choix littéral ?',
    options: [' oui ', 'non'],
  });
  t.faux.lignes.set(1235, v);
  const p = await t.action.preparer(
    { mesh: 'principal', params: { requestId: 1235, digest: v.digest, decision: ' oui ' } },
    t.ctx,
  );
  expect(p.decision).toBe(' oui ');
  await t.action.executer(p, t.ctx);
  expect(t.ctx.envoi?.code).toBe('envoyee_rendu_inattendu');
});

it.each(['decision\u202e', 'decision\n', 'decision\u200b', 'x'.repeat(101)])(
  'refuse un type distant non affichable (%s)',
  (type) => {
    const ligne = ligneCommandantTest();
    ligne.type = type;
    ligne.needs_sso = true;
    ligne.digest = digestCommandant(ligne);
    expect(controlerLigneCommandant(ligne)).toEqual({
      valide: false,
      id: ligne.id,
      raison: 'forme',
    });
  },
);

it('rogne la réponse libre avant signature et accepte le rendu identique de la passerelle', async () => {
  const t = await preparer();
  const ligne = ligneCommandantTest(1235, 'decision', {
    question: 'Question libre ?',
    options: [],
  });
  t.faux.lignes.set(1235, ligne);
  const p = await t.action.preparer(
    {
      mesh: 'principal',
      params: { requestId: 1235, digest: ligne.digest, decision: '  oui libre  ' },
    },
    t.ctx,
  );
  expect(p.decision).toBe('oui libre');
  await t.action.executer(p, t.ctx);
  expect(t.ctx.envoi?.code).toBe('succes');
  expect(t.faux.lignes.get(1235)).toMatchObject({ answer: 'oui libre', decided_via: 'cockpit' });
});
