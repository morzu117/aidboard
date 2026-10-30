import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Server } from '../../../src/shared/model.js';
import { statutInconnu, useServeurs } from '../data/serveurs.js';
import { ETAT_SERVEUR, IconeServeur } from './Serveur.js';

// Repli des groupes serveurs : ni table ni route en v1 (S.6). Gardé au niveau du module, il survit
// au remontage de Nav à chaque écran, pas au rechargement de la page.
const replies = new Set<string>();

/** Réservé aux tests : un cas n'hérite pas des groupes repliés du précédent. */
export function resetNavServeursForTests(): void {
  replies.clear();
}

/**
 * Groupes par `groupName`, dans l'ordre de création des serveurs (le glisser-déposer est hors v1).
 * Couleur du groupe = celle de son plus ancien serveur : la couleur est un réglage du serveur (S.5).
 */
function grouper(servers: Server[]): { nom: string; couleur: string; servers: Server[] }[] {
  const groupes = new Map<string, { nom: string; couleur: string; servers: Server[] }>();
  for (const s of servers) {
    const nom = s.groupName.trim() || 'Serveurs';
    const g = groupes.get(nom);
    if (g) g.servers.push(s);
    else groupes.set(nom, { nom, couleur: s.color, servers: [s] });
  }
  return [...groupes.values()];
}

/** Chantier 17 (S.6) : section « Serveurs » de la barre gauche, une ligne `NavServer` par serveur. */
export function NavServeurs({ n }: { n: (rest: string) => string }) {
  const { servers, statuses, erreur } = useServeurs();
  const { pathname } = useLocation();
  const [, rendre] = useState(0);
  const basculer = (nom: string) => {
    if (replies.has(nom)) replies.delete(nom);
    else replies.add(nom);
    rendre((v) => v + 1);
  };
  const liste = servers ?? [];
  return (
    <div className="barre-gauche-serveurs" data-node={n('serveurs')}>
      <div className="barre-gauche-serveurs-entete">
        <h2 className="titre-zone">
          <Link
            to="/serveurs"
            className="barre-gauche-serveurs-lien"
            data-node={n('serveurs.liste')}
            aria-current={pathname === '/serveurs' ? 'page' : undefined}
          >
            Serveurs
          </Link>
        </h2>
        <Link
          to="/serveurs/nouveau"
          className="barre-gauche-actions"
          data-node={n('serveurs.ajouter')}
          aria-label="Ajouter un serveur"
          title="Ajouter un serveur"
        >
          +
        </Link>
      </div>
      {servers === null && erreur && (
        <p
          className="barre-gauche-serveurs-vide texte-faible"
          role="status"
          data-node={n('serveurs.erreur')}
        >
          Serveurs indisponibles
        </p>
      )}
      {servers !== null && liste.length === 0 && (
        <p className="barre-gauche-serveurs-vide texte-faible" data-node={n('serveurs.vide')}>
          Aucun serveur
        </p>
      )}
      {grouper(liste).map((g) => {
        const replie = replies.has(g.nom);
        return (
          <div
            key={g.nom}
            className="barre-gauche-groupe"
            data-node={n(`serveurs.groupe-${g.nom}`)}
          >
            <div className="barre-gauche-groupe-ligne">
              <button
                type="button"
                className="barre-gauche-groupe-entete"
                data-node={n(`serveurs.groupe-${g.nom}.bascule`)}
                aria-expanded={!replie}
                onClick={() => basculer(g.nom)}
              >
                <span
                  className="barre-gauche-groupe-couleur"
                  style={{ background: g.couleur }}
                  aria-hidden="true"
                />
                <span className="barre-gauche-groupe-nom">{g.nom}</span>
                <span className="barre-gauche-compte">{g.servers.length}</span>
              </button>
            </div>
            {!replie &&
              g.servers.map((s) => {
                const status = statuses[s.id] ?? statutInconnu(s.id);
                // R.6 : la ligne ouvre la discussion du serveur (la plus récente, ou sa création)
                const actif = pathname.startsWith(`/serveurs/${s.id}/`);
                const horsLigne = status.state === 'unreachable' || status.state === 'error';
                return (
                  <div key={s.id} className="barre-gauche-sujet-ligne">
                    <Link
                      to={`/serveurs/${s.id}/discussion`}
                      className={`barre-gauche-sujet barre-gauche-serveur barre-gauche-serveur--${status.state}${actif ? ' est-actif' : ''}`}
                      data-node={n(`serveur-${s.id}`)}
                      data-etat={status.state}
                      title={status.reason ?? undefined}
                      aria-current={actif ? 'page' : undefined}
                    >
                      <IconeServeur state={status.state} taille={15} />
                      <span className="barre-gauche-sujet-nom">{s.name}</span>
                      {/* l'icône est décorative : l'état se lit aussi quand la latence le remplace */}
                      {status.latencyMs !== null && !horsLigne && (
                        <span className="visuellement-cache">{ETAT_SERVEUR[status.state]}, </span>
                      )}
                      <span
                        className="barre-gauche-sujet-temps"
                        data-node={n(`serveur-${s.id}.etat`)}
                      >
                        {status.latencyMs !== null && !horsLigne
                          ? `${status.latencyMs} ms`
                          : ETAT_SERVEUR[status.state]}
                      </span>
                      {/* la raison n'est pas qu'au survol : clavier, tactile et lecteur d'écran l'ont aussi */}
                      {horsLigne && status.reason && (
                        <span className="visuellement-cache">, {status.reason}</span>
                      )}
                    </Link>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
