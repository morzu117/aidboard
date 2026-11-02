import {
  AID_COMMANDS,
  type AgentCommand,
  type AgentOptions,
  type AgentSettings,
} from '../../../src/shared/agentSettings.js';

/** D86 : le menu s'ouvre sur un `/` en tête du message, tant qu'aucune espace ne suit le nom. */
export function saisieCommande(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]! : null;
}

/** D86 : par préfixe d'abord, puis par sous-chaîne ; l'ordre reçu (A-I-D en tête) est gardé dans chaque groupe. */
export function filtrerCommandes(commands: AgentCommand[], requete: string): AgentCommand[] {
  const q = requete.toLowerCase();
  const nom = (c: AgentCommand) => c.name.toLowerCase();
  const prefixe = commands.filter((c) => nom(c).startsWith(q));
  const dedans = commands.filter((c) => !nom(c).startsWith(q) && nom(c).includes(q));
  return [...prefixe, ...dedans];
}

/** Le texte une fois la commande choisie : une espace quand elle attend des arguments, ou qu'elle part à l'agent. */
export function completer(c: AgentCommand): string {
  return c.args || c.source === 'agent' ? `/${c.name} ` : `/${c.name}`;
}

export interface CommandeAid {
  name: string;
  args: string;
}

/** D81 : une commande qu'A-I-D exécute lui-même ; tout autre `/xxx` part tel quel à l'agent (D85). */
export function commandeAid(text: string): CommandeAid | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !AID_COMMANDS.some((c) => c.name === m[1])) return null;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

export type Reglage = { patch: Partial<AgentSettings>; avis: string } | { erreur: string };

const PAR_DEFAUT = new Set(['defaut', 'défaut', 'default']);
const egal = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base' }) === 0;

/**
 * D81 : `/model`, `/effort` et `/mode` deviennent le même réglage que les chips du composer, avec les choix que
 * l'agent propose (`options`). Un choix inconnu est refusé en listant les choix possibles.
 */
export function reglageDe(c: CommandeAid, o: AgentOptions, courant: AgentSettings): Reglage | null {
  if (c.name === 'model') {
    const possibles = o.models.map((m) => m.id);
    if (!c.args) return { erreur: `/model <id> : ${['défaut', ...possibles].join(', ')}` };
    if (PAR_DEFAUT.has(c.args.toLowerCase()))
      return { patch: { model: null }, avis: 'Modèle : par défaut' };
    const m = o.models.find((x) => egal(x.id, c.args) || egal(x.label, c.args));
    if (!m)
      return {
        erreur: `Modèle inconnu : ${c.args}. Possibles : ${['défaut', ...possibles].join(', ')}`,
      };
    return { patch: { model: m.id }, avis: `Modèle : ${m.label}` };
  }
  if (c.name === 'effort') {
    const modele = o.models.find((m) => m.id === courant.model);
    const efforts = modele?.efforts.length ? modele.efforts : o.efforts;
    if (!c.args) return { erreur: `/effort <niveau> : ${['défaut', ...efforts].join(', ')}` };
    if (PAR_DEFAUT.has(c.args.toLowerCase()))
      return { patch: { effort: null }, avis: 'Effort : par défaut' };
    const e = efforts.find((x) => egal(x, c.args));
    if (!e)
      return {
        erreur: `Effort inconnu : ${c.args}. Possibles : ${['défaut', ...efforts].join(', ')}`,
      };
    return { patch: { effort: e }, avis: `Effort : ${e}` };
  }
  if (c.name === 'mode') {
    const possibles = o.modes.map((m) => m.id);
    if (!c.args) return { erreur: `/mode <id> : ${possibles.join(', ')}` };
    const m = o.modes.find((x) => egal(x.id, c.args) || egal(x.label, c.args));
    if (!m) return { erreur: `Mode inconnu : ${c.args}. Possibles : ${possibles.join(', ')}` };
    return { patch: { mode: m.id }, avis: `Mode : ${m.label}` };
  }
  return null;
}

/** `/aide` : les commandes d'A-I-D, puis le nombre de celles de l'agent (le menu les montre toutes). */
export function aide(commands: AgentCommand[]): string {
  const aid = commands.filter((c) => c.source === 'aid');
  const agent = commands.filter((c) => c.source === 'agent');
  const lignes = aid.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  const suite =
    agent.length > 0
      ? `Et ${agent.length} commande${agent.length > 1 ? 's' : ''} de l’agent : tape « / » pour les voir.`
      : 'L’agent n’a pas encore annoncé de commandes : elles apparaissent après son premier tour.';
  return [...lignes, suite].join('\n');
}
