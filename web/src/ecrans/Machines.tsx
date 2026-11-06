import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type {
  MachineServeur,
  Server,
  ServerStatus,
  ServerTest,
} from '../../../src/shared/model.js';
import { type MachinesEtat, useMachines } from '../data/machines.js';
import { statutInconnu, useServeurs } from '../data/serveurs.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import {
  accesDe,
  agentsDeLaCarte,
  blocage,
  libelleMemoire,
  MAC,
  repriseServeur,
} from '../ui/machinesVue.js';
import { PastilleEtatServeur } from '../ui/Serveur.js';
import { isAlive } from '../ui/Statut.js';

// Chantier 29 : l'écran Machines (D151). Rien d'illustratif : chaque valeur vient d'une lecture ou d'un diagnostic.

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const sessions = (n: number) => (n === 1 ? '1 session active' : `${n} sessions actives`);

interface Case {
  id: string;
  label: string;
  valeur: string;
  ok?: boolean;
}

function CarteMachine({
  id,
  nom,
  etat,
  actives,
  cases,
  enCours,
  bloque,
  onDiagnostiquer,
  children,
}: {
  id: string;
  nom: string;
  etat: ReactNode;
  actives: number;
  cases: Case[];
  enCours: boolean;
  bloque: string | null;
  onDiagnostiquer: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="machine-carte" data-node={id} aria-label={nom}>
      <div className="machine-carte-entete">
        <span className="machine-carte-nom" data-node={`${id}.nom`}>
          {nom}
        </span>
        {etat}
        <span className="texte-discret" data-node={`${id}.sessions`}>
          {sessions(actives)}
        </span>
      </div>
      <dl className="machine-cases">
        {cases.map((c) => (
          <div key={c.id} className="machine-case" data-node={`${id}.${c.id}`}>
            <dt>{c.label}</dt>
            <dd data-ok={c.ok === undefined ? undefined : String(c.ok)}>
              {c.ok === true && '✓ '}
              {c.valeur}
            </dd>
          </div>
        ))}
      </dl>
      {bloque && (
        <p className="message-erreur" role="alert" data-node={`${id}.blocage`}>
          {bloque}
        </p>
      )}
      <div className="machine-actions">
        <button
          className="bouton"
          data-node={`${id}.diagnostiquer`}
          data-action="machine.diagnostiquer"
          type="button"
          disabled={enCours}
          onClick={onDiagnostiquer}
        >
          {enCours ? 'Diagnostic…' : 'Diagnostiquer'}
        </button>
        {children}
      </div>
    </section>
  );
}

function CarteMac({ m }: { m: MachinesEtat }) {
  const { state } = useAid();
  const actives = (state?.agents ?? []).filter(
    (a) => (a.kind === 'claude' || a.kind === 'codex') && isAlive(a),
  ).length;
  const local = m.local;
  const trouves = local?.agents.filter((a) => a.trouve) ?? null;
  const versions = Object.fromEntries((local?.agents ?? []).map((a) => [a.kind, a.version]));
  const cases: Case[] = [
    { id: 'acces', label: 'Accès', valeur: 'daemon local', ok: true },
    {
      id: 'agents',
      label: 'Agents',
      valeur: trouves
        ? agentsDeLaCarte(
            trouves.map((a) => a.kind),
            versions,
          )
        : '[non mesuré]',
      ok: trouves ? trouves.length > 0 : undefined,
    },
    {
      id: 'reprise',
      label: 'Reprise',
      valeur: !local
        ? '[non mesuré]'
        : local.transport === 'stream'
          ? 'session persistante'
          : 'sans reprise (terminal)',
      ok: local ? local.transport === 'stream' : undefined,
    },
    {
      id: 'memoire',
      label: 'Mémoire libre',
      valeur: local?.memoire
        ? `${libelleMemoire(local.memoire)} · mesurée à ${heure(local.memoire.mesureA)}`
        : libelleMemoire(null),
    },
  ];
  return (
    <CarteMachine
      id="machines.machine-local"
      nom={MAC.nom}
      etat={
        <span className="pastille pastille--etat" data-node="machines.machine-local.etat">
          Disponible
        </span>
      }
      actives={actives}
      cases={cases}
      enCours={m.enCours.has('local')}
      bloque={m.erreurs.local ?? null}
      onDiagnostiquer={() => void m.diagnostiquer('local')}
    />
  );
}

function CarteServeur({
  s,
  status,
  testVif,
  diagnostic,
  m,
  onFini,
}: {
  s: Server;
  status: ServerStatus;
  testVif: ServerTest | undefined;
  diagnostic: MachineServeur | undefined;
  m: MachinesEtat;
  onFini: () => void;
}) {
  const navigate = useNavigate();
  const id = `machines.machine-${s.id}`;
  const test = diagnostic?.test ?? testVif ?? null;
  const enCours = m.enCours.has(s.id);
  const reprise = test
    ? repriseServeur(test)
    : s.keepSession
      ? '[non mesuré]'
      : 'session désactivée';
  const cases: Case[] = [
    {
      id: 'acces',
      label: 'Accès',
      valeur: accesDe(s),
      ok: status.state === 'connected' || undefined,
    },
    {
      id: 'agents',
      label: 'Agents',
      valeur: agentsDeLaCarte(s.detectedAgents, diagnostic?.versions ?? null),
      ok: s.detectedAgents === null ? undefined : s.detectedAgents.length > 0,
    },
    {
      id: 'reprise',
      label: 'Reprise',
      valeur: reprise,
      ok: reprise === 'session persistante' || undefined,
    },
    {
      id: 'memoire',
      label: 'Mémoire libre',
      valeur: diagnostic?.memoire
        ? `${libelleMemoire(diagnostic.memoire)} · mesurée à ${heure(diagnostic.memoire.mesureA)}`
        : libelleMemoire(null),
    },
  ];
  return (
    <CarteMachine
      id={id}
      nom={s.name}
      etat={
        <span className="machine-etat">
          <PastilleEtatServeur state={status.state} dataNode={`${id}.etat`} />
          {status.state === 'connected' && status.latencyMs !== null && (
            <span className="texte-discret" data-node={`${id}.latence`}>
              {status.latencyMs} ms
            </span>
          )}
        </span>
      }
      actives={status.agents?.vivants ?? 0}
      cases={cases}
      enCours={enCours}
      bloque={m.erreurs[s.id] ?? (enCours ? null : blocage(test))}
      // les agents détectés viennent d'être réenregistrés : la liste des serveurs est relue
      onDiagnostiquer={() => void m.diagnostiquer(s.id).then(onFini)}
    >
      <button
        className="bouton"
        data-node={`${id}.configurer`}
        type="button"
        onClick={() => navigate(`/serveurs/${s.id}/configuration`)}
      >
        Configurer
      </button>
      <button
        className="bouton"
        data-node={`${id}.discussion`}
        type="button"
        onClick={() => navigate(`/serveurs/${s.id}/discussion`)}
      >
        Ouvrir une discussion
      </button>
    </CarteMachine>
  );
}

function Contenu() {
  const navigate = useNavigate();
  const m = useMachines();
  const { servers, statuses, tests, store } = useServeurs();
  return (
    <main className="page machines" data-node="machines.page">
      <div className="entete" data-node="machines.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="machines.entete.titre">
            Machines
          </h1>
          <p className="resume">
            Ce qui tourne où, ce que chaque combinaison sait vraiment faire, et par quel accès.
          </p>
        </div>
        <button
          className="bouton bouton--primaire"
          data-node="machines.ajouter"
          data-action="machine.ajouter"
          type="button"
          onClick={() => navigate('/serveurs/nouveau')}
        >
          Ajouter une machine
        </button>
      </div>
      {m.erreur && (
        <p className="message-erreur" role="alert" data-node="machines.erreur">
          {m.erreur}
        </p>
      )}

      <section className="machines-section" data-node="machines.cockpit" aria-labelledby="mc-titre">
        <div className="machines-section-entete">
          <h2 id="mc-titre" className="titre-zone">
            Ton cockpit
          </h2>
          <span className="pastille pastille--discret" data-node="machines.cockpit.mode">
            Mode host inactif
          </span>
        </div>
        <p className="texte-discret" data-node="machines.cockpit.phrase">
          Ce cockpit n’écoute que sur ce Mac (127.0.0.1). Les autres appareils viendront avec le
          mode host.
        </p>
        <ul className="machines-appareils" data-node="machines.cockpit.appareils">
          <li data-node="machines.cockpit.appareil-local">
            <span className="machine-carte-nom">Mac local · ici</span>
            <span className="texte-discret">Héberge le cockpit</span>
          </li>
        </ul>
      </section>

      <section className="machines-section" data-node="machines.liste" aria-labelledby="ml-titre">
        <h2 id="ml-titre" className="titre-zone">
          Machines
        </h2>
        <CarteMac m={m} />
        {servers?.map((s) => (
          <CarteServeur
            key={s.id}
            s={s}
            status={statuses[s.id] ?? statutInconnu(s.id)}
            testVif={tests[s.id]}
            diagnostic={m.serveurs[s.id]}
            m={m}
            onFini={() => void store.recharger()}
          />
        ))}
      </section>
    </main>
  );
}

export function Machines() {
  return (
    <Layout screen="machines">
      <Contenu />
    </Layout>
  );
}
