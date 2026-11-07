import { useEffect, useState } from 'react';
import type { Appareil, EtatModeHostDaemon, VueDemande } from '../../../src/shared/host.js';
import { type ModeHostEtat, useModeHost } from '../data/host.js';
import { depuis } from './depuis.js';
import { Qr } from './Qr.js';

// Chantier 31 (D172, D176, D177, D181) : Machines › Ton cockpit. Le mode host, l'ajout d'un
// appareil par QR, et les appareils connectés. Tout se décide ici, sur le Mac. La case « sans
// identité » repart décochée à chaque demande : le composant est remonté par sa clé.

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export type Pilule = { texte: string; ton: 'discret' | 'ok' | 'attente' | 'erreur' };

export function pilule(e: EtatModeHostDaemon | null): Pilule {
  if (!e || !e.actif) return { texte: 'Mode host inactif', ton: 'discret' };
  if (e.serve.funnel) return { texte: 'Funnel actif : sur internet', ton: 'erreur' };
  if (e.serve.interdits.length > 0)
    return { texte: 'Serve expose un port interdit', ton: 'erreur' };
  if (!e.disponible) return { texte: 'Port des appareils indisponible', ton: 'attente' };
  if (e.serve.etat !== 'ok') return { texte: 'Serve absent', ton: 'attente' };
  return { texte: 'Mode host actif', ton: 'ok' };
}

function useMaintenant(actif: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!actif) return;
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, [actif]);
  return t;
}

function restant(expireA: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(expireA) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Commande({ commande }: { commande: string }) {
  const [copie, setCopie] = useState(false);
  return (
    <div className="host-commande" data-node="host.commande">
      <p className="texte-discret">
        Tailscale Serve ne vise pas le port des appareils. A-I-D ne pilote pas Tailscale : lance
        toi-même, sur ce Mac :
      </p>
      <code data-node="host.commande.texte">{commande}</code>
      <button
        className="bouton bouton--discret"
        type="button"
        data-node="host.commande.copier"
        onClick={() =>
          void navigator.clipboard.writeText(commande).then(
            () => setCopie(true),
            () => undefined,
          )
        }
      >
        {copie ? 'Copiée' : 'Copier'}
      </button>
    </div>
  );
}

function Demande({ h, d, now }: { h: ModeHostEtat; d: VueDemande | null; now: number }) {
  const [sansIdentite, setSansIdentite] = useState(false);
  const qr = h.qr!;
  const nouveau = (
    <button
      className="bouton"
      type="button"
      data-node="host.nouveau-code"
      disabled={h.occupe}
      onClick={() => void h.nouveauCode()}
    >
      Nouveau code
    </button>
  );
  if (d?.etat === 'reclamee') {
    const peutApprouver = d.identite !== null || sansIdentite;
    return (
      <div className="host-demande" data-node="host.demande">
        <p className="host-avertissement" role="alert" data-node="host.demande.avertissement">
          Si tu n’as pas lancé cette connexion, refuse.
        </p>
        <dl className="host-demande-champs">
          <dt>Code affiché sur l’appareil</dt>
          <dd className="host-code-court" data-node="host.demande.code-court">
            {d.codeCourt}
          </dd>
          <dt>Nom proposé</dt>
          <dd data-node="host.demande.nom">{d.nom}</dd>
          <dt>Identité Tailscale</dt>
          <dd data-node="host.demande.identite">
            {d.identite === null
              ? 'Aucune'
              : `${d.identite}${h.identiteVerifiable ? '' : ' (non vérifiable)'}`}
          </dd>
        </dl>
        {d.identite === null && (
          <label className="host-case" data-node="host.demande.sans-identite">
            <input
              type="checkbox"
              checked={sansIdentite}
              onChange={(e) => setSansIdentite(e.target.checked)}
            />
            Appareil taggé, sans identité Tailscale
          </label>
        )}
        <div className="host-actions">
          <button
            className="bouton bouton--primaire"
            type="button"
            data-node="host.demande.approuver"
            disabled={h.occupe || !peutApprouver}
            onClick={() => void h.approuver(d.id, d.identite === null && sansIdentite)}
          >
            Approuver
          </button>
          <button
            className="bouton bouton--danger"
            type="button"
            data-node="host.demande.refuser"
            disabled={h.occupe}
            onClick={() => void h.refuser(d.id)}
          >
            Refuser
          </button>
        </div>
      </div>
    );
  }
  if (d?.etat === 'approuvee') {
    return <p data-node="host.demande.fin">Approuvé : l’appareil prend son accès.</p>;
  }
  if (d?.etat === 'consommee') {
    return (
      <div className="host-demande" data-node="host.demande">
        <p data-node="host.demande.fin">Appareil ajouté. L’accès dure 8 heures.</p>
        <button className="bouton" type="button" data-node="host.fermer" onClick={h.fermerQr}>
          Fermer
        </button>
      </div>
    );
  }
  if (d?.etat === 'annulee' || d?.etat === 'expiree') {
    const texte =
      d.etat === 'expiree'
        ? 'Code expiré.'
        : d.raison === 'deux-reclamations'
          ? 'Deux appareils ont essayé ce code : demande annulée.'
          : d.raison === 'refusee'
            ? 'Demande refusée.'
            : 'Demande annulée.';
    return (
      <div className="host-demande" data-node="host.demande">
        <p role="alert" data-node="host.demande.fin">
          {texte}
        </p>
        {nouveau}
      </div>
    );
  }
  const finie = Date.parse(qr.expireA) <= now;
  return (
    <div className="host-qr" data-node="host.qr-zone">
      <Qr texte={qr.url} titre="QR d’appairage de cet appareil" />
      <div className="host-qr-texte">
        <p>Scanne ce code avec l’appareil à ajouter, sur le même tailnet.</p>
        <p className="texte-discret" data-node="host.qr.restant">
          {finie ? 'Code expiré' : `Expire dans ${restant(qr.expireA, now)}`}
        </p>
        {nouveau}
      </div>
    </div>
  );
}

function Ligne({ a, h }: { a: Appareil & { push?: boolean }; h: ModeHostEtat }) {
  return (
    <li data-node={`host.appareil.${a.id}`}>
      <span className="machine-carte-nom">{a.nom}</span>
      {a.push && <span>Notifications</span>}
      <span className="texte-discret">{a.identite ?? 'sans identité Tailscale'}</span>
      <span className="texte-discret">
        {a.dernierContact ? `vu ${depuis(a.dernierContact)}` : 'jamais vu'}
      </span>
      {a.etat === 'actif' ? (
        <>
          <span className="texte-discret">jusqu’à {heure(a.expireA)}</span>
          <button
            className="bouton bouton--danger"
            type="button"
            data-node={`host.appareil.${a.id}.revoquer`}
            disabled={h.occupe}
            onClick={() => void h.revoquer(a.id)}
          >
            Révoquer
          </button>
        </>
      ) : (
        <span className="pastille pastille--discret">
          {a.etat === 'expire' ? 'Expiré' : 'Coupé'}
        </span>
      )}
    </li>
  );
}

export function Cockpit() {
  const h = useModeHost();
  const e = h.etat;
  const p = pilule(e);
  const now = useMaintenant(h.qr !== null);
  const actifs = h.appareils.filter((a) => a.etat === 'actif');
  return (
    <section className="machines-section" data-node="machines.cockpit" aria-labelledby="mc-titre">
      <div className="machines-section-entete">
        <h2 id="mc-titre" className="titre-zone">
          Ton cockpit
        </h2>
        <span className={`pastille pastille--host-${p.ton}`} data-node="machines.cockpit.mode">
          {p.texte}
        </span>
        {e && (
          <button
            className={`bouton ${e.actif ? 'bouton--danger' : ''}`}
            type="button"
            data-node="host.interrupteur"
            disabled={h.occupe}
            onClick={() => void h.basculer(!e.actif)}
          >
            {e.actif ? 'Éteindre le mode host' : 'Activer le mode host'}
          </button>
        )}
      </div>
      <p className="texte-discret" data-node="machines.cockpit.phrase">
        {e?.actif
          ? `Ce cockpit écoute sur ce Mac (127.0.0.1). Tes appareils du tailnet entrent par Tailscale Serve, sur ${e.tailnet.nom ?? 'le nom du Mac'}, en lecture seule, 8 heures par accès.`
          : 'Ce cockpit n’écoute que sur ce Mac (127.0.0.1). Le mode host ouvre une lecture seule à tes appareils du tailnet, par Tailscale Serve.'}
      </p>
      {e && (
        <div>
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={e.push ?? false}
              disabled={h.occupe}
              onChange={() => {
                if (
                  !e.push ||
                  window.confirm('Couper les notifications ? Tous les abonnements seront effacés.')
                )
                  void h.basculerPush(!e.push);
              }}
            />
            Notifications push sur les téléphones
          </label>
          <p>
            Les notifications passent par Apple ou Google. Elles ne contiennent qu’un nombre de
            décisions.
          </p>
          <p>{e.abonnements ?? 0} abonnements</p>
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={e.code ?? false}
              disabled={h.occupe}
              onChange={() => void h.basculerCode(!e.code)}
            />
            Montrer le code aux appareils
          </label>
          <p>
            Les téléphones appairés pourront lire le diff des fichiers d&apos;une livraison, filtré.
            Les fichiers sensibles restent sur le Mac.
          </p>
        </div>
      )}
      {h.erreur && (
        <p className="message-erreur" role="alert" data-node="host.erreur">
          {h.erreur}
        </p>
      )}
      {e?.actif && e.raison && (
        <p className="texte-discret" data-node="host.raison">
          {e.raison}
        </p>
      )}
      {e?.actif && e.serve.etat !== 'ok' && <Commande commande={e.commande} />}
      <ul className="machines-appareils" data-node="machines.cockpit.appareils">
        <li data-node="machines.cockpit.appareil-local">
          <span className="machine-carte-nom">Mac local · ici</span>
          <span className="texte-discret">Héberge le cockpit</span>
        </li>
        {h.appareils.map((a) => (
          <Ligne key={a.id} a={a} h={h} />
        ))}
      </ul>
      {e?.actif && (
        <div className="host-actions">
          {h.qr === null && (
            <button
              className="bouton bouton--primaire"
              type="button"
              data-node="host.ajouter"
              disabled={h.occupe || !e.disponible}
              onClick={() => void h.nouveauCode()}
            >
              Ajouter un appareil
            </button>
          )}
          {actifs.length > 0 && (
            <button
              className="bouton bouton--danger"
              type="button"
              data-node="host.couper"
              disabled={h.occupe}
              onClick={() => void h.couper()}
            >
              Couper tous les accès
            </button>
          )}
        </div>
      )}
      {e?.actif && h.qr && (
        <Demande
          key={h.demande?.id ?? h.qr.demandeId}
          h={h}
          d={h.demande?.id === h.qr.demandeId ? h.demande : null}
          now={now}
        />
      )}
    </section>
  );
}
