import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage, RequestListener } from 'node:http';
import { decoderBase64url, estBasse, hacher, octetsRequeteRelais } from '../shared/pda.js';

export interface OptionsRelais {
  origineApp: string;
  cleDaemon: string;
  now?: () => number;
  confianceProxy?: boolean;
  limiteCorps?: number;
  limiteDemandes?: number;
  limiteReponses?: number;
  limiteDebit?: number;
  margeHeure?: number;
  journal?: (entree: {
    methode: string;
    route: string;
    statut: number;
    id?: string;
    appareil?: string;
  }) => void;
}

const APPAREIL = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SIGNATURES = 16384;
const MAX_ADRESSES = 4096;

function objet(valeur: unknown): Record<string, unknown> {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur))
    throw new Error('Objet attendu');
  return valeur as Record<string, unknown>;
}

function clePublique(valeur: unknown): KeyObject {
  const cle = objet(valeur);
  if (
    Object.keys(cle).sort().join(',') !== 'crv,kty,x,y' ||
    cle.kty !== 'EC' ||
    cle.crv !== 'P-256' ||
    typeof cle.x !== 'string' ||
    typeof cle.y !== 'string' ||
    decoderBase64url(cle.x).length !== 32 ||
    decoderBase64url(cle.y).length !== 32
  )
    throw new Error('Clé invalide');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: cle.x, y: cle.y }, format: 'jwk' });
}

/** Aucun stockage durable, aucune minuterie et aucune interprétation métier des enveloppes. */
export function creerRelais(options: OptionsRelais): RequestListener {
  const origine = new URL(options.origineApp);
  if (origine.protocol !== 'https:' || origine.origin !== options.origineApp)
    throw new Error('Origine HTTPS exacte requise');
  const raw = decoderBase64url(options.cleDaemon);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Clé daemon invalide');
  const daemon = clePublique({
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(raw.slice(1, 33)).toString('base64url'),
    y: Buffer.from(raw.slice(33)).toString('base64url'),
  });
  const now = options.now ?? Date.now;
  const journal = options.journal ?? console.log;
  const limites = {
    corps: options.limiteCorps ?? 16 * 1024,
    demandes: options.limiteDemandes ?? 32,
    reponses: options.limiteReponses ?? 128,
    debit: options.limiteDebit ?? 60,
    marge: options.margeHeure ?? 60000,
  };
  for (const valeur of Object.values(limites))
    if (!Number.isSafeInteger(valeur) || valeur <= 0) throw new Error('Limite invalide');
  let autorises = new Map<string, KeyObject>();
  const demandes = new Map<
    string,
    { corps: string; sig: string; echeance: number; reponses: number }
  >();
  const reponses = new Map<
    number,
    { curseur: number; id: string; appareil: string; corps: string; recue: number }
  >();
  const resultats = new Map<string, { corps: string; sig: string; recue: number }>();
  const signatures = new Map<string, number>();
  const adresses = new Map<string, { debut: number; nombre: number }>();
  let curseur = 0;

  function purger(heure: number) {
    for (const [id, resultat] of resultats)
      if (resultat.recue + 24 * 60 * 60_000 <= heure) resultats.delete(id);
    for (const [id, demande] of demandes) if (demande.echeance <= heure) demandes.delete(id);
    for (const [n, reponse] of reponses) if (reponse.recue + 600000 <= heure) reponses.delete(n);
    for (const [sig, expiration] of signatures) if (expiration < heure) signatures.delete(sig);
    for (const [adresse, compteur] of adresses)
      if (compteur.debut + 60000 <= heure) adresses.delete(adresse);
  }
  function debit(req: IncomingMessage): boolean {
    const transfert = req.headers['x-forwarded-for'];
    const adresse =
      options.confianceProxy && typeof transfert === 'string'
        ? transfert.split(',').at(-1)!.trim()
        : (req.socket.remoteAddress ?? '');
    let compteur = adresses.get(adresse);
    if (!compteur) {
      if (adresses.size >= MAX_ADRESSES) return false;
      compteur = { debut: now(), nombre: 0 };
      adresses.set(adresse, compteur);
    }
    return ++compteur.nombre <= limites.debit;
  }

  return (req, res) => {
    const methode = req.method ?? '';
    const chemin = req.url ?? '';
    const correspondance = /^\/(demandes|reponses|resultats)\/([A-Za-z0-9_-]{22})$/.exec(chemin);
    const id = correspondance?.[2];
    const route =
      chemin === '/autorises'
        ? '/autorises'
        : chemin === '/demandes' || chemin === '/resultats'
          ? chemin
          : /^\/reponses\?apres=(0|[1-9]\d{0,15})$/.test(chemin)
            ? '/reponses'
            : correspondance
              ? `/${correspondance[1]}/:id`
              : 'inconnue';
    const app =
      (methode === 'GET' && (route === '/demandes' || route === '/resultats')) ||
      (methode === 'POST' && route === '/reponses/:id');
    const privee =
      (methode === 'PUT' && route === '/resultats/:id') ||
      (methode === 'PUT' && route === '/autorises') ||
      ((methode === 'PUT' || methode === 'DELETE') && route === '/demandes/:id') ||
      (methode === 'GET' && route === '/reponses');
    let appareil: string | undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.headers.origin === options.origineApp)
      res.setHeader('Access-Control-Allow-Origin', options.origineApp);
    res.setHeader('Vary', 'Origin');
    function finir(statut: number, contenu?: unknown) {
      res.statusCode = statut;
      if (contenu !== undefined) res.setHeader('Content-Type', 'application/json');
      res.end(contenu === undefined ? undefined : JSON.stringify(contenu));
      journal({
        methode: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(methode) ? methode : 'autre',
        route,
        statut,
        ...(id ? { id } : {}),
        ...(appareil ? { appareil } : {}),
      });
    }
    purger(now());
    const traiter = async () => {
      // La borne s'applique avant toute authentification, même avec Transfer-Encoding: chunked.
      const morceaux: Buffer[] = [];
      let taille = 0;
      for await (const morceau of req) {
        const octets = Buffer.from(morceau);
        taille += octets.length;
        if (
          taille >
          (route === '/resultats/:id' && methode === 'PUT'
            ? Math.min(1024, limites.corps)
            : app && methode === 'POST'
              ? Math.min(8192, limites.corps)
              : limites.corps)
        ) {
          finir(413);
          return;
        }
        morceaux.push(octets);
      }
      const corps = Buffer.concat(morceaux);
      if (
        methode === 'OPTIONS' &&
        (route === '/demandes' || route === '/resultats' || route === '/reponses/:id')
      ) {
        if (!debit(req)) return finir(429);
        if (req.headers.origin === options.origineApp) {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'X-Aid-Heure, X-Aid-Sig, X-Aid-Appareil, Content-Type',
          );
          res.setHeader('Access-Control-Max-Age', '600');
        }
        return finir(204);
      }
      if (!app && !privee) return finir(404);
      let compte = false;
      if (app) {
        compte = true;
        if (!debit(req)) return finir(429);
      }
      function refuser() {
        finir(!compte && !debit(req) ? 429 : 401);
      }
      const heure = req.headers['x-aid-heure'];
      const sig = req.headers['x-aid-sig'];
      const identite = req.headers['x-aid-appareil'];
      if (
        typeof heure !== 'string' ||
        !/^(0|[1-9]\d{0,15})$/.test(heure) ||
        !Number.isSafeInteger(Number(heure)) ||
        typeof sig !== 'string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(sig) ||
        (app && (typeof identite !== 'string' || !APPAREIL.test(identite)))
      )
        return refuser();
      if (Math.abs(now() - Number(heure)) > limites.marge) return refuser();
      const cle = app ? autorises.get(identite as string) : daemon;
      if (!cle) return refuser();
      let signature: Uint8Array;
      try {
        signature = decoderBase64url(sig);
      } catch {
        return refuser();
      }
      if (!estBasse(signature)) return refuser();
      const octets = octetsRequeteRelais({
        methode,
        chemin,
        hachageCorps: await hacher(corps),
        heure,
      });
      const empreinte = await hacher(octets);
      // Recontrôle après le hachage asynchrone ; les mutations suivantes sont synchrones.
      purger(now());
      if (
        Math.abs(now() - Number(heure)) > limites.marge ||
        (app && autorises.get(identite as string) !== cle) ||
        !verify('sha256', octets, { key: cle, dsaEncoding: 'ieee-p1363' }, signature) ||
        signatures.has(empreinte) ||
        signatures.size >= MAX_SIGNATURES
      )
        return refuser();
      signatures.set(empreinte, Number(heure) + limites.marge);
      if (app) appareil = identite as string;
      try {
        if (route === '/autorises') {
          const liste = objet(JSON.parse(corps.toString('utf8')));
          if (
            Object.keys(liste).join() !== 'appareils' ||
            !Array.isArray(liste.appareils) ||
            liste.appareils.length > 64
          )
            return finir(400);
          const suivantes = new Map<string, KeyObject>();
          for (const valeur of liste.appareils) {
            const a = objet(valeur);
            if (
              Object.keys(a).sort().join() !== 'cle,id' ||
              typeof a.id !== 'string' ||
              !APPAREIL.test(a.id) ||
              suivantes.has(a.id)
            )
              return finir(400);
            suivantes.set(a.id, clePublique(a.cle));
          }
          autorises = suivantes;
          return finir(204);
        }
        if (route === '/resultats')
          return finir(200, {
            resultats: [...resultats.values()].map(({ corps, sig }) => ({ corps, sig })),
          });
        if (route === '/resultats/:id' && id) {
          const enveloppe = objet(JSON.parse(corps.toString('utf8')));
          if (
            Object.keys(enveloppe).sort().join() !== 'corps,sig' ||
            typeof enveloppe.corps !== 'string' ||
            typeof enveloppe.sig !== 'string'
          )
            return finir(400);
          const contenu = objet(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(decoderBase64url(enveloppe.corps)),
            ),
          );
          if (contenu.id !== id) return finir(400);
          resultats.delete(id);
          resultats.set(id, { corps: enveloppe.corps, sig: enveloppe.sig, recue: now() });
          if (resultats.size > 50) resultats.delete(resultats.keys().next().value!);
          return finir(204);
        }
        if (route === '/demandes/:id' && id) {
          if (methode === 'DELETE') {
            demandes.delete(id);
            return finir(204);
          }
          const enveloppe = objet(JSON.parse(corps.toString('utf8')));
          if (
            Object.keys(enveloppe).sort().join() !== 'corps,sig' ||
            typeof enveloppe.corps !== 'string' ||
            typeof enveloppe.sig !== 'string'
          )
            return finir(400);
          const contenu = objet(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(decoderBase64url(enveloppe.corps)),
            ),
          );
          if (!Number.isSafeInteger(contenu.echeance) || (contenu.echeance as number) <= now())
            return finir(400);
          if (!demandes.has(id) && demandes.size >= limites.demandes) return finir(429);
          const precedent = demandes.get(id);
          demandes.set(id, {
            corps: enveloppe.corps,
            sig: enveloppe.sig,
            echeance: contenu.echeance as number,
            reponses: precedent?.reponses ?? 0,
          });
          return finir(204);
        }
        if (route === '/demandes')
          return finir(
            200,
            [...demandes].map(([id, { corps, sig }]) => ({ id, corps, sig })),
          );
        if (route === '/reponses/:id' && id && appareil) {
          const demande = demandes.get(id);
          if (!demande) return finir(404);
          if (
            demande.reponses >= 4 ||
            reponses.size >= limites.reponses ||
            curseur >= Number.MAX_SAFE_INTEGER
          )
            return finir(429);
          demande.reponses++;
          curseur++;
          reponses.set(curseur, {
            curseur,
            id,
            appareil,
            corps: corps.toString('base64url'),
            recue: now(),
          });
          return finir(204);
        }
        const apres = Number(chemin.slice('/reponses?apres='.length));
        if (!Number.isSafeInteger(apres)) return finir(400);
        const tirees = [...reponses.values()].filter((r) => r.curseur > apres);
        for (const r of tirees) reponses.delete(r.curseur);
        return finir(
          200,
          tirees.map(({ curseur, id, appareil, corps }) => ({ curseur, id, appareil, corps })),
        );
      } catch {
        finir(400);
      }
    };
    void traiter().catch(() => {
      if (!res.writableEnded && !res.destroyed) finir(400);
    });
  };
}
