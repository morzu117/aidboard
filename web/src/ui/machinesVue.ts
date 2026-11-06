import { CAPACITES, type Capacite, capacitesDe, type Lieu } from '../../../src/shared/capacites.js';
import type {
  Fournisseurs,
  MachineLocale,
  MachineServeur,
  Memoire,
  Server,
  ServerTest,
} from '../../../src/shared/model.js';

// Chantier 29 : les règles de l'écran Machines, sans rendu (D157, D158).

/** ✓ fait et vérifié sur la machine, ? fait mais machine jamais diagnostiquée, – absent, jamais proposé. */
export type Marque = '✓' | '?' | '–';

export type EtatCombinaison =
  'Prêt' | 'Prêt, limité' | 'À tester' | 'Agent non détecté' | 'Détecté, non piloté par A-I-D';

export interface Combinaison {
  id: string;
  agent: string;
  modele: string;
  fournisseur: string;
  acces: string;
  machineId: string;
  machine: string;
  marques: Record<Capacite, Marque>;
  etat: EtatCombinaison;
}

/** Les agents qu'A-I-D pilote ; cursor, trouvé par le test, a sa ligne sans rien de proposé. */
const PILOTES = ['claude', 'codex'] as const;
const FOURNISSEUR: Record<(typeof PILOTES)[number], string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
};

export const MAC = { id: 'local', nom: 'Mac local' } as const;

/** « 12,3 Go » ; « [non mesuré] » sans mesure. */
export function libelleMemoire(m: Memoire | null): string {
  if (!m) return '[non mesuré]';
  return `${(m.octets / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

/** La case Accès d'une carte de serveur. */
export function accesDe(s: Pick<Server, 'mode' | 'target'>): string {
  if (s.mode === 'ssh_alias') return `alias SSH ${s.target}`;
  if (s.mode === 'ssh_host') return `SSH ${s.target}`;
  return `commande ${s.target}`;
}

/** La case Agents d'une carte : les agents trouvés, avec leur version quand elle est connue. */
export function agentsDeLaCarte(
  detectes: string[] | null,
  versions: Record<string, string | null> | null,
): string {
  if (detectes === null) return 'Jamais diagnostiqué';
  if (detectes.length === 0) return 'Aucun agent';
  return detectes.map((a) => (versions?.[a] ? `${a} ${versions[a]}` : a)).join(' · ');
}

/** La case Reprise d'une carte de serveur, d'après l'étape `session` du dernier test. */
export function repriseServeur(test: ServerTest | null): string {
  const s = test?.steps.find((x) => x.id === 'session');
  if (!s || s.state === 'pending' || s.state === 'running') return '[non mesuré]';
  if (s.state === 'ok') return 'session persistante';
  if (s.state === 'skipped') return test?.ok === false ? '[non mesuré]' : 'session désactivée';
  return 'sans tmux';
}

/** L'étape en échec d'un test, pour dire où ça bloque. */
export function blocage(test: ServerTest | null): string | null {
  if (!test || test.ok !== false) return null;
  const s = test.steps.find((x) => x.state === 'failed');
  return s ? `${s.label} : ${s.detail ?? test.error ?? 'échec'}` : test.error;
}

export function etatCombinaison(marques: Record<Capacite, Marque>): EtatCombinaison {
  const valeurs = CAPACITES.filter((c) => c.id !== 'conso').map((c) => marques[c.id]);
  if (valeurs.includes('?')) return 'À tester';
  if (valeurs.includes('–')) return 'Prêt, limité';
  return 'Prêt';
}

function marquesDe(
  capacites: Record<Capacite, boolean> | null,
  verifie: boolean,
): Record<Capacite, Marque> {
  const out = {} as Record<Capacite, Marque>;
  for (const c of CAPACITES) out[c.id] = !capacites?.[c.id] ? '–' : verifie ? '✓' : '?';
  return out;
}

export interface EntreesCombinaisons {
  local: MachineLocale | null;
  serveurs: Array<{ server: Server; diagnostic: MachineServeur | null }>;
  fournisseurs: Fournisseurs | null;
}

/**
 * D158 : une ligne par agent piloté (claude, codex) sur chaque machine, plus cursor là où il a été trouvé. Le Mac
 * est diagnostiqué à chaque lecture ; un serveur l'est dès qu'un test a lu ses agents (`detectedAgents`).
 */
export function combinaisons(e: EntreesCombinaisons): Combinaison[] {
  const acces = (agent: string) =>
    e.fournisseurs?.fournisseurs.find((f) => f.agent === agent)?.acces ??
    'Identifiants gérés par le CLI';
  const efforts = (kind: (typeof PILOTES)[number]) => {
    const a = e.local?.agents.find((x) => x.kind === kind);
    return a ? a.options.efforts.length > 0 : kind === 'claude';
  };
  const lignes: Combinaison[] = [];
  const ligne = (
    machine: { id: string; nom: string },
    agent: string,
    lieu: Lieu,
    trouve: boolean | null,
  ) => {
    const pilote = (PILOTES as readonly string[]).includes(agent);
    const kind = agent as (typeof PILOTES)[number];
    const caps = pilote && trouve !== false ? capacitesDe(kind, lieu, efforts(kind)) : null;
    const marques = marquesDe(caps, trouve === true);
    lignes.push({
      id: `${machine.id}:${agent}`,
      agent,
      modele: pilote ? 'Par défaut' : '—',
      fournisseur: pilote ? FOURNISSEUR[kind] : '—',
      acces: pilote ? acces(agent) : '—',
      machineId: machine.id,
      machine: machine.nom,
      marques,
      etat: !pilote
        ? 'Détecté, non piloté par A-I-D'
        : trouve === false
          ? 'Agent non détecté'
          : etatCombinaison(marques),
    });
  };
  if (e.local) {
    const lieu: Lieu = { machine: 'mac', transport: e.local.transport };
    for (const kind of PILOTES)
      ligne(MAC, kind, lieu, e.local.agents.find((a) => a.kind === kind)?.trouve ?? false);
  }
  for (const { server } of e.serveurs) {
    const lieu: Lieu = { machine: 'serveur', transport: 'stream' };
    const d = server.detectedAgents;
    const m = { id: server.id, nom: server.name };
    for (const kind of PILOTES) ligne(m, kind, lieu, d === null ? null : d.includes(kind));
    for (const autre of d ?? [])
      if (!(PILOTES as readonly string[]).includes(autre)) ligne(m, autre, lieu, true);
  }
  return lignes;
}

/** Filtre de la matrice : toutes, le Mac (`local`), ou un serveur par son id. */
export function filtrer(lignes: Combinaison[], filtre: string): Combinaison[] {
  return filtre === 'toutes' ? lignes : lignes.filter((l) => l.machineId === filtre);
}
