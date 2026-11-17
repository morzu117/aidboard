import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  digestCommandant,
  questionRepondable,
  texteCommandantValide,
  type LigneCommandant,
  type JsonCommandant,
} from '../../src/shared/commandant.js';

export const IDENTIFIANT_COCKPIT_TEST = 'swck_' + 'a'.repeat(43);
export const DATE_COMMANDANT_TEST = '2026-11-17T07:14:44.520968+00:00';

/** Champs A1, noms neutres ; les valeurs dérivées sont recalculées à chaque lecture. */
export function ligneCommandantTest(
  id = 1235,
  type = 'decision',
  params?: Record<string, JsonCommandant>,
): LigneCommandant {
  const p: Record<string, JsonCommandant> =
    params ??
    (type === 'decision'
      ? { needs_sso: false, options: ['oui', 'non'], question: 'Activer le cockpit de test ?' }
      : type === 'merge_pr'
        ? { head_sha: 'a'.repeat(40), pr: 12, repo: 'exemple/depot' }
        : {
            before: [{ app_id: 10, context: 'test precedent' }],
            branch: 'main',
            checks: [{ app_id: 10, context: 'test actuel' }],
            repo: 'exemple/depot',
          });
  return rendreLigneCommandant({
    id,
    proposer: 'cell-lab',
    type,
    params: p,
    card_id: 42,
    head_sha: p.head_sha ?? null,
    question: p.question ?? null,
    options: p.options ?? null,
    status: 'pending',
    created_at: DATE_COMMANDANT_TEST,
    decided_at: null,
    answer: null,
    result: null,
    summary: [],
    why: null,
    digest: '',
    needs_sso: type === 'decision' ? ((p.needs_sso ?? false) as boolean) : true,
    decided_by: null,
    decided_via: null,
    executed_at: null,
    executed_by: null,
    result_detail: null,
  });
}
export function rendreLigneCommandant(ligne: LigneCommandant): LigneCommandant {
  const v = structuredClone(ligne);
  v.digest = digestCommandant(v);
  if (v.type === 'decision') {
    if (!questionRepondable(v.params))
      v.summary = ['This question exceeds the cockpit limits: answer it in the Command Center.'];
    else {
      const question = [...(v.params.question as string)];
      const morceaux: string[] = [];
      for (let i = 0; i < question.length; i += 120)
        morceaux.push(question.slice(i, i + 120).join(''));
      v.summary = [
        `Question from ${v.proposer}:`,
        ...morceaux,
        ...(v.params.options as string[]).map((option) => `Option: ${option}`),
        ...(v.needs_sso ? ['Needs the SSO session: the cockpit cannot answer this one.'] : []),
      ];
    }
  } else if (v.type === 'merge_pr')
    v.summary = [`Merge PR #${v.params.pr} in ${v.params.repo}`, `at head ${v.params.head_sha}`];
  else {
    const avant = v.params.before as Array<{ app_id: number; context: string }>;
    const apres = v.params.checks as Array<{ app_id: number; context: string }>;
    const contient = (liste: typeof avant, cible: (typeof avant)[number]) =>
      liste.some((c) => c.app_id === cible.app_id && c.context === cible.context);
    const decrire = (verbe: string, c: (typeof avant)[number]) =>
      `${verbe}: ${c.context} [app ${c.app_id}]`;
    v.summary = [
      `Replace required status checks on ${v.params.repo}, branch ${v.params.branch}`,
      ...apres.filter((c) => contient(avant, c)).map((c) => decrire('kept', c)),
      ...avant.filter((c) => !contient(apres, c)).map((c) => decrire('removed', c)),
      ...apres.filter((c) => !contient(avant, c)).map((c) => decrire('added', c)),
      `were ${avant.length} checks, become ${apres.length}`,
    ];
  }
  return v;
}
export interface AppelPasserelleCommandant {
  methode: string;
  chemin: string;
  authorization: string | undefined;
  corps: unknown;
}

export async function creerPasserelleCommandant() {
  const lignes = new Map<number, LigneCommandant>(
    [
      ligneCommandantTest(),
      ligneCommandantTest(1234, 'merge_pr'),
      ligneCommandantTest(1236, 'required_checks'),
    ].map((v) => [v.id, v]),
  );
  const appels: AppelPasserelleCommandant[] = [];
  const scenario = {
    identifiant: 'valide' as 'valide' | 'expire' | 'revoque' | 'inconnu',
    digestFaux: false,
    avantDetail: null as null | ((id: number) => void),
    delaiMs: 0,
    erreurListe: null as null | { http: number; corps: unknown },
    corpsListe: undefined as unknown,
    texteBrut: null as string | null,
  };
  const serveur = createServer(async (req, res) => {
    const morceaux: Buffer[] = [];
    for await (const morceau of req) morceaux.push(Buffer.from(morceau));
    let corps: Record<string, unknown> = {};
    try {
      if (morceaux.length) corps = JSON.parse(Buffer.concat(morceaux).toString());
    } catch {
      /* le faux rend bad_decision */
    }
    appels.push({
      methode: req.method ?? '',
      chemin: req.url ?? '',
      authorization: req.headers.authorization,
      corps,
    });
    if (scenario.delaiMs) await new Promise((r) => setTimeout(r, scenario.delaiMs));
    const envoyer = (http: number, valeur: unknown) => {
      res.writeHead(http, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(valeur));
    };
    const erreur = (http: number, error: string) => envoyer(http, { error });
    // Le middleware s'applique avant toutes les routes, y compris inconnues.
    const etats = { expire: 'expired', revoque: 'revoked', inconnu: 'unknown' } as const;
    if (scenario.identifiant !== 'valide')
      return erreur(401, `cockpit_credential_${etats[scenario.identifiant]}`);
    if (req.headers.authorization !== `Bearer ${IDENTIFIANT_COCKPIT_TEST}`)
      return erreur(401, 'cockpit_credential_unknown');
    const url = new URL(req.url!, 'http://example.com');
    const correspondance = /^\/commander\/requests\/(\d+)(\/decide)?$/.exec(url.pathname);
    const liste = req.method === 'GET' && url.pathname === '/commander/requests';
    const detail = req.method === 'GET' && correspondance && !correspondance[2];
    const decide = req.method === 'POST' && correspondance?.[2] === '/decide';
    if (!liste && !detail && !decide) return erreur(403, 'cockpit_not_allowed');
    if (liste) {
      if (scenario.erreurListe)
        return envoyer(scenario.erreurListe.http, scenario.erreurListe.corps);
      if (scenario.texteBrut !== null) {
        res.end(scenario.texteBrut);
        return;
      }
      if (scenario.corpsListe !== undefined) return envoyer(200, scenario.corpsListe);
      return envoyer(
        200,
        [...lignes.values()]
          .filter((v) => url.searchParams.get('status') !== 'pending' || v.status === 'pending')
          .map(rendre),
      );
    }
    const id = Number(correspondance![1]);
    if (detail) scenario.avantDetail?.(id);
    const ligne = lignes.get(id);
    if (!ligne) return erreur(404, 'not_found');
    if (detail) return envoyer(200, rendre(ligne));
    if (ligne.type !== 'decision') return erreur(403, 'cockpit_not_allowed');
    if (ligne.needs_sso || !questionRepondable(ligne.params)) return erreur(403, 'needs_sso');
    if (!Object.hasOwn(corps, 'decision'))
      return envoyer(422, {
        detail: [
          { type: 'missing', loc: ['body', 'decision'], msg: 'Field required', input: corps },
        ],
      });
    if (corps.decision !== 'answer') return erreur(400, 'bad_decision');
    if (!Object.hasOwn(corps, 'answer'))
      return envoyer(422, {
        detail: [{ type: 'missing', loc: ['body', 'answer'], msg: 'Field required', input: corps }],
      });
    if (!texteCommandantValide(corps.answer, 1000) || !corps.answer.length)
      return erreur(400, 'bad_answer');
    if (typeof corps.digest !== 'string' || !/^[a-f0-9]{64}$/.test(corps.digest))
      return erreur(400, 'digest_required');
    if (ligne.status !== 'pending')
      return envoyer(409, { error: 'not_pending', status: ligne.status });
    if (corps.digest !== digestCommandant(ligne)) return erreur(409, 'digest_mismatch');
    Object.assign(ligne, {
      status: 'answered',
      answer: corps.answer,
      decided_by: 'cockpit:ck_1234abcd',
      decided_via: 'cockpit',
      decided_at: DATE_COMMANDANT_TEST,
    });
    return envoyer(200, rendre(ligne));
  });
  function rendre(ligne: LigneCommandant) {
    const v = rendreLigneCommandant(ligne);
    if (scenario.digestFaux) v.digest = '0'.repeat(64);
    return v;
  }
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    lignes,
    appels,
    scenario,
    async fermer() {
      serveur.closeAllConnections();
      await new Promise<void>((r, j) => serveur.close((e) => (e ? j(e) : r())));
    },
  };
}
