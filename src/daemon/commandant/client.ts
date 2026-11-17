import { identifiantCockpitValide } from './identifiant.js';
import { STATUTS_COMMANDANT, type StatutCommandant } from '../../shared/commandant.js';

export type CodeErreurCommandant =
  | 'digest_mismatch'
  | 'needs_sso'
  | 'cockpit_not_allowed'
  | 'not_found'
  | 'bad_decision'
  | 'bad_answer'
  | 'digest_required'
  | 'cockpit_credential_unknown'
  | 'cockpit_credential_revoked'
  | 'cockpit_credential_expired';
export type ErreurCommandant =
  | { genre: 'passerelle'; http: number; code: CodeErreurCommandant }
  | { genre: 'passerelle'; http: 409; code: 'not_pending'; statut: StatutCommandant }
  | { genre: 'validation'; http: 422; code: 'champ_requis'; champs: Array<Array<string | number>> }
  | {
      genre: 'transport';
      code: 'delai' | 'taille' | 'reseau' | 'json' | 'http' | 'gateway' | 'identifiant' | 'requete';
      http?: number;
    };
export type ResultatCommandant<T> =
  { ok: true; valeur: T } | { ok: false; erreur: ErreurCommandant };
const CODES: Record<number, readonly string[]> = {
  400: ['bad_decision', 'bad_answer', 'digest_required'],
  401: ['cockpit_credential_unknown', 'cockpit_credential_revoked', 'cockpit_credential_expired'],
  403: ['needs_sso', 'cockpit_not_allowed'],
  404: ['not_found'],
  409: ['digest_mismatch'],
};

/** Les corps distants et les messages du transport ne sont jamais propagés. */
export function erreurCommandant(http: number, corps: unknown, secret: string): ErreurCommandant {
  const v = corps as { error?: unknown; status?: unknown; detail?: unknown } | null;
  if (typeof v?.error === 'string' && CODES[http]?.includes(v.error))
    return { genre: 'passerelle', http, code: v.error as CodeErreurCommandant };
  if (
    http === 409 &&
    v?.error === 'not_pending' &&
    STATUTS_COMMANDANT.includes(v.status as StatutCommandant)
  )
    return { genre: 'passerelle', http, code: 'not_pending', statut: v.status as StatutCommandant };
  if (http === 422 && Array.isArray(v?.detail)) {
    // FastAPI peut inclure input, ctx et un message portant le secret. Seules les localisations restent.
    const champs = v.detail.flatMap((detail: unknown) => {
      const loc = (detail as { loc?: unknown } | null)?.loc;
      return Array.isArray(loc) &&
        loc.every(
          (x) =>
            (typeof x === 'string' && !x.includes(secret) && !x.includes('swck_')) ||
            typeof x === 'number',
        )
        ? [loc as Array<string | number>]
        : [];
    });
    return { genre: 'validation', http, code: 'champ_requis', champs };
  }
  return { genre: 'transport', code: 'http', http };
}

export interface OptionsClientCommandant {
  delaiMs?: number;
  maximumOctets?: number;
  transport?: typeof fetch;
}

/** hostname est déjà validé et normalisé par URL, y compris les adresses IPv6. */
function hoteHttpAutorise(hote: string): boolean {
  if (
    hote === 'localhost' ||
    hote === '[::1]' ||
    hote.endsWith('.ts.net') ||
    hote.startsWith('[fd7a:115c:a1e0:')
  )
    return true;
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hote);
  return (
    ipv4 !== null &&
    (Number(ipv4[1]) === 127 ||
      (Number(ipv4[1]) === 100 && Number(ipv4[2]) >= 64 && Number(ipv4[2]) <= 127))
  );
}

export class ClientCommandant {
  constructor(
    private readonly gateway: string,
    private readonly identifiant: string,
    private readonly options: OptionsClientCommandant = {},
  ) {}
  liste(): Promise<ResultatCommandant<unknown>> {
    return this.appeler('/commander/requests?status=pending');
  }
  detail(id: number): Promise<ResultatCommandant<unknown>> {
    return this.appeler(`/commander/requests/${id}`, undefined, id);
  }
  decider(id: number, answer: string, digest: string): Promise<ResultatCommandant<unknown>> {
    if (typeof answer !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      return Promise.resolve({ ok: false, erreur: { genre: 'transport', code: 'requete' } });
    return this.appeler(
      `/commander/requests/${id}/decide`,
      { decision: 'answer', answer, digest },
      id,
    );
  }
  private async appeler(
    chemin: string,
    corps?: object,
    id?: number,
  ): Promise<ResultatCommandant<unknown>> {
    let http: number | undefined;
    const refus = (
      code: Extract<ErreurCommandant, { genre: 'transport' }>['code'],
    ): ResultatCommandant<unknown> => ({
      ok: false,
      erreur: { genre: 'transport', code, ...(http === undefined ? {} : { http }) },
    });
    let url: URL;
    try {
      url = new URL(this.gateway);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return refus('gateway');
      if (url.protocol === 'http:' && !hoteHttpAutorise(url.hostname)) return refus('gateway');
      url.pathname = url.pathname.replace(/\/$/, '') + chemin.split('?')[0];
      url.search = chemin.includes('?') ? chemin.split('?')[1]! : '';
    } catch {
      return refus('gateway');
    }
    if (!identifiantCockpitValide(this.identifiant)) return refus('identifiant');
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 0)) return refus('requete');
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.options.delaiMs ?? 10_000);
    minuteur.unref();
    let lecteur: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const reponse = await (this.options.transport ?? fetch)(url, {
        method: corps ? 'POST' : 'GET',
        redirect: 'manual',
        signal: controleur.signal,
        headers: {
          Authorization: `Bearer ${this.identifiant}`,
          ...(corps ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(corps ? { body: JSON.stringify(corps) } : {}),
      });
      http = reponse.status;
      const maximum = this.options.maximumOctets ?? 1024 * 1024;
      if (Number(reponse.headers.get('content-length') ?? 0) > maximum) {
        await reponse.body?.cancel();
        return refus('taille');
      }
      lecteur = reponse.body?.getReader();
      const morceaux: Uint8Array[] = [];
      let taille = 0;
      if (lecteur) {
        for (;;) {
          const { done, value } = await lecteur.read();
          if (done) break;
          taille += value.byteLength;
          if (taille > maximum) {
            await lecteur.cancel();
            return refus('taille');
          }
          morceaux.push(value);
        }
      }
      let valeur: unknown;
      try {
        valeur = JSON.parse(Buffer.concat(morceaux).toString('utf8'));
      } catch {
        return reponse.ok
          ? refus('json')
          : { ok: false, erreur: erreurCommandant(reponse.status, null, this.identifiant) };
      }
      if (!reponse.ok)
        return { ok: false, erreur: erreurCommandant(reponse.status, valeur, this.identifiant) };
      // Une passerelle compromise peut réfléchir l'en-tête dans une ligne ou une clé JSON.
      if (
        JSON.stringify(valeur).includes(this.identifiant) ||
        JSON.stringify(valeur).includes('swck_')
      )
        return refus('json');
      return { ok: true, valeur };
    } catch {
      return refus(controleur.signal.aborted ? 'delai' : 'reseau');
    } finally {
      clearTimeout(minuteur);
      lecteur?.releaseLock();
    }
  }
}
