import { expect, test } from 'vitest';
import {
  AID_COMMANDS,
  type AgentCommand,
  type AgentOptions,
  type AgentSettings,
  CLAUDE_MODELS,
  MODES,
} from '../../src/shared/agentSettings.js';
import {
  aide,
  commandeAid,
  completer,
  filtrerCommandes,
  reglageDe,
  saisieCommande,
} from '../../web/src/conversation/commandes.js';

/** Chantier 22 (B.1) : la logique pure du menu des commandes `/` du composer. */
const agentCmd = (name: string): AgentCommand => ({
  name,
  description: `Commande ${name}`,
  source: 'agent',
});
const COMMANDES: AgentCommand[] = [
  ...AID_COMMANDS,
  agentCmd('context'),
  agentCmd('deep-research'),
  agentCmd('databricks:doctor'),
];
const noms = (cs: AgentCommand[]) => cs.map((c) => c.name);

const CLAUDE: AgentOptions = {
  modes: MODES.claude,
  models: CLAUDE_MODELS,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  commands: COMMANDES,
};
/** Un catalogue à la codex : chaque modèle a ses efforts, le premier n'en annonce aucun. */
const CODEX: AgentOptions = {
  modes: MODES.codex,
  models: [
    { id: 'gpt-nu', label: 'GPT nu', efforts: [] },
    { id: 'gpt-mini', label: 'GPT Mini', efforts: ['minimal', 'low'] },
  ],
  efforts: ['minimal', 'low', 'high'],
  commands: AID_COMMANDS,
};
const DEFAUT: AgentSettings = { mode: 'default', model: null, effort: null };
const cmd = (name: string, args = '') => ({ name, args });

test('saisieCommande : un `/` en tête et pas encore d’espace ; sinon rien', () => {
  expect(saisieCommande('/')).toBe('');
  expect(saisieCommande('/mo')).toBe('mo');
  expect(saisieCommande('/databricks:doctor')).toBe('databricks:doctor');
  expect(saisieCommande('/model ')).toBeNull();
  expect(saisieCommande('/model opus')).toBeNull();
  expect(saisieCommande('/mo\nsuite')).toBeNull();
  expect(saisieCommande(' /mo')).toBeNull();
  expect(saisieCommande('mo')).toBeNull();
  expect(saisieCommande('')).toBeNull();
  expect(saisieCommande('a/b')).toBeNull();
});

test('filtrerCommandes : requête vide, tout dans l’ordre reçu (A-I-D en tête)', () => {
  expect(filtrerCommandes(COMMANDES, '')).toEqual(COMMANDES);
});

test('filtrerCommandes : par préfixe d’abord, puis par sous-chaîne, l’ordre reçu gardé dans chaque groupe', () => {
  expect(noms(filtrerCommandes(COMMANDES, 'mo'))).toEqual(['model', 'mode']);
  expect(noms(filtrerCommandes(COMMANDES, 'co'))).toEqual(['compact', 'context']);
  // « de » : deep-research par préfixe passe devant model, mode et aide, reçus avant lui
  expect(noms(filtrerCommandes(COMMANDES, 'de'))).toEqual([
    'deep-research',
    'model',
    'mode',
    'aide',
  ]);
  // « e » : effort par préfixe, puis tous ceux qui le contiennent, dans l’ordre reçu
  expect(noms(filtrerCommandes(COMMANDES, 'e'))).toEqual([
    'effort',
    'model',
    'mode',
    'aide',
    'context',
    'deep-research',
  ]);
  // une sous-chaîne seule, sans aucun préfixe
  expect(noms(filtrerCommandes(COMMANDES, 'tor'))).toEqual(['databricks:doctor']);
  expect(noms(filtrerCommandes(COMMANDES, 'research'))).toEqual(['deep-research']);
});

test('filtrerCommandes : insensible à la casse ; rien ne correspond, liste vide', () => {
  expect(noms(filtrerCommandes(COMMANDES, 'MO'))).toEqual(['model', 'mode']);
  expect(filtrerCommandes(COMMANDES, 'inconnu')).toEqual([]);
  expect(filtrerCommandes([], '')).toEqual([]);
});

test('completer : une espace quand la commande attend des arguments ou part à l’agent', () => {
  expect(completer(AID_COMMANDS.find((c) => c.name === 'model')!)).toBe('/model ');
  expect(completer(AID_COMMANDS.find((c) => c.name === 'effort')!)).toBe('/effort ');
  expect(completer(AID_COMMANDS.find((c) => c.name === 'compact')!)).toBe('/compact');
  expect(completer(AID_COMMANDS.find((c) => c.name === 'aide')!)).toBe('/aide');
  expect(completer(agentCmd('context'))).toBe('/context ');
});

test('commandeAid : les seules commandes d’A-I-D, avec leurs arguments ; tout autre `/xxx` n’en est pas une', () => {
  expect(commandeAid('/model opus')).toEqual(cmd('model', 'opus'));
  expect(commandeAid('  /model   Opus 5.5  ')).toEqual(cmd('model', 'Opus 5.5'));
  expect(commandeAid('/aide')).toEqual(cmd('aide'));
  expect(commandeAid('/stop')).toEqual(cmd('stop'));
  expect(commandeAid('/compact')).toEqual(cmd('compact'));
  expect(commandeAid('/effort\nhigh')).toEqual(cmd('effort', 'high'));
  for (const t of ['/context', '/inconnu', '/Model opus', 'model opus', '/', 'bonjour /model', ''])
    expect(commandeAid(t)).toBeNull();
});

test('reglageDe /model : par id ou par libellé, sans tenir compte de la casse ; l’avis donne le libellé', () => {
  expect(reglageDe(cmd('model', 'opus'), CLAUDE, DEFAUT)).toEqual({
    patch: { model: 'opus' },
    avis: 'Modèle : Opus 5.5',
  });
  expect(reglageDe(cmd('model', 'OPUS'), CLAUDE, DEFAUT)).toEqual({
    patch: { model: 'opus' },
    avis: 'Modèle : Opus 5.5',
  });
  expect(reglageDe(cmd('model', 'sonnet 5.5'), CLAUDE, DEFAUT)).toEqual({
    patch: { model: 'sonnet' },
    avis: 'Modèle : Sonnet 5.5',
  });
});

test('reglageDe /model : défaut, default ou Défaut remettent le modèle de la CLI', () => {
  for (const d of ['défaut', 'defaut', 'default', 'Défaut', 'DEFAULT'])
    expect(reglageDe(cmd('model', d), CLAUDE, DEFAUT)).toEqual({
      patch: { model: null },
      avis: 'Modèle : par défaut',
    });
});

test('reglageDe /model : un effort que le nouveau modèle ne connaît pas repasse au défaut, comme le chip', () => {
  const haut = { ...DEFAUT, model: 'gpt-nu', effort: 'high' };
  expect(reglageDe(cmd('model', 'gpt-mini'), CODEX, haut)).toEqual({
    patch: { model: 'gpt-mini', effort: null },
    avis: 'Modèle : GPT Mini (effort : par défaut)',
  });
  // effort connu du nouveau modèle : il reste, le patch n'y touche pas
  expect(reglageDe(cmd('model', 'gpt-mini'), CODEX, { ...haut, effort: 'low' })).toEqual({
    patch: { model: 'gpt-mini' },
    avis: 'Modèle : GPT Mini',
  });
  // nouveau modèle sans efforts annoncés : ceux de l'agent valent, l'effort reste
  expect(reglageDe(cmd('model', 'gpt-nu'), CODEX, { ...haut, model: 'gpt-mini' })).toEqual({
    patch: { model: 'gpt-nu' },
    avis: 'Modèle : GPT nu',
  });
  // pas d'effort courant : rien à remettre
  expect(reglageDe(cmd('model', 'gpt-mini'), CODEX, { ...haut, effort: null })).toEqual({
    patch: { model: 'gpt-mini' },
    avis: 'Modèle : GPT Mini',
  });
});

test('reglageDe /model : inconnu ou sans argument, une erreur qui liste les possibles', () => {
  expect(reglageDe(cmd('model', 'gpt'), CLAUDE, DEFAUT)).toEqual({
    erreur: 'Modèle inconnu : gpt. Possibles : défaut, fable, opus, sonnet, haiku',
  });
  expect(reglageDe(cmd('model'), CLAUDE, DEFAUT)).toEqual({
    erreur: '/model <id> : défaut, fable, opus, sonnet, haiku',
  });
});

test('reglageDe /effort : les efforts du modèle courant s’il en a, sinon ceux de l’agent', () => {
  const mini = { ...DEFAUT, model: 'gpt-mini' };
  expect(reglageDe(cmd('effort', 'LOW'), CODEX, mini)).toEqual({
    patch: { effort: 'low' },
    avis: 'Effort : low',
  });
  // `high` existe pour l’agent mais pas pour gpt-mini
  expect(reglageDe(cmd('effort', 'high'), CODEX, mini)).toEqual({
    erreur: 'Effort inconnu : high. Possibles : défaut, minimal, low',
  });
  // gpt-nu n’annonce aucun effort : ceux de l’agent
  expect(reglageDe(cmd('effort', 'high'), CODEX, { ...DEFAUT, model: 'gpt-nu' })).toEqual({
    patch: { effort: 'high' },
    avis: 'Effort : high',
  });
  // modèle par défaut : ceux de l’agent
  expect(reglageDe(cmd('effort', 'high'), CODEX, DEFAUT)).toEqual({
    patch: { effort: 'high' },
    avis: 'Effort : high',
  });
  expect(reglageDe(cmd('effort'), CODEX, mini)).toEqual({
    erreur: '/effort <niveau> : défaut, minimal, low',
  });
  expect(reglageDe(cmd('effort', 'défaut'), CODEX, mini)).toEqual({
    patch: { effort: null },
    avis: 'Effort : par défaut',
  });
});

test('reglageDe /mode : par id ou par libellé ; inconnu ou sans argument, les possibles (sans « défaut »)', () => {
  expect(reglageDe(cmd('mode', 'plan'), CLAUDE, DEFAUT)).toEqual({
    patch: { mode: 'plan' },
    avis: 'Permissions : Plan seulement',
  });
  expect(reglageDe(cmd('mode', 'modifier sans demander'), CLAUDE, DEFAUT)).toEqual({
    patch: { mode: 'acceptEdits' },
    avis: 'Permissions : Modifier sans demander',
  });
  expect(reglageDe(cmd('mode', 'ACCEPTEDITS'), CLAUDE, DEFAUT)).toEqual({
    patch: { mode: 'acceptEdits' },
    avis: 'Permissions : Modifier sans demander',
  });
  // codex n’a pas de mode plan
  expect(reglageDe(cmd('mode', 'plan'), CODEX, DEFAUT)).toEqual({
    erreur: 'Mode inconnu : plan. Possibles : default, auto',
  });
  expect(reglageDe(cmd('mode'), CLAUDE, DEFAUT)).toEqual({
    erreur: '/mode <id> : default, acceptEdits, auto, plan',
  });
  // « default » est ici l’id du mode « Demander avant d'écrire », pas le défaut de la CLI
  expect(reglageDe(cmd('mode', 'default'), CLAUDE, DEFAUT)).toEqual({
    patch: { mode: 'default' },
    avis: "Permissions : Demander avant d'écrire",
  });
});

test('reglageDe : stop, aide et compact ne sont pas des réglages', () => {
  for (const n of ['stop', 'aide', 'compact']) expect(reglageDe(cmd(n), CLAUDE, DEFAUT)).toBeNull();
});

test('aide : une ligne par commande d’A-I-D, puis le nombre de celles de l’agent', () => {
  const lignes = aide(COMMANDES).split('\n');
  expect(lignes).toEqual([
    '/model <id> — Changer de modèle',
    '/effort <niveau> — Changer l’effort de raisonnement',
    '/mode <id> — Changer le mode d’exécution',
    '/compact — Compacter la conversation',
    '/stop — Interrompre le tour en cours',
    '/aide — Lister les commandes',
    'Et 3 commandes de l’agent : tape « / » pour les voir.',
  ]);
  expect(
    aide([...AID_COMMANDS, agentCmd('context')])
      .split('\n')
      .at(-1),
  ).toBe('Et 1 commande de l’agent : tape « / » pour les voir.');
  expect(aide(AID_COMMANDS).split('\n').at(-1)).toBe(
    'L’agent n’a pas encore annoncé de commandes : elles apparaissent après son premier tour.',
  );
});
