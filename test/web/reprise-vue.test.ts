import { expect, test } from 'vitest';
import {
  alerteTransfert,
  boutonReprise,
  type CibleReprise,
  messageTransfert,
  optionsReprise,
  titreReprise,
} from '../../web/src/ui/repriseVue.js';

const local = (over: Partial<Extract<CibleReprise, { lieu: 'local' }>> = {}): CibleReprise => ({
  lieu: 'local',
  kind: 'claude',
  reprenable: true,
  session: true,
  sujetOuvert: true,
  ...over,
});
const serveur = (over: Partial<Extract<CibleReprise, { lieu: 'serveur' }>> = {}): CibleReprise => ({
  lieu: 'serveur',
  kind: 'claude',
  session: true,
  suivi: 'coupe',
  processus: 'arrete',
  ...over,
});

const possibles = (c: CibleReprise) => {
  const o = optionsReprise(c);
  return {
    reconnecter: o.reconnecter.possible,
    reprendre: o.reprendre.possible,
    transferer: o.transferer.possible,
    defaut: o.defaut,
  };
};

test('D147 : un agent local en veille se reprend sur sa session, ou se transfère', () => {
  expect(possibles(local())).toEqual({
    reconnecter: false,
    reprendre: true,
    transferer: true,
    defaut: 'reprendre',
  });
  expect(optionsReprise(local()).reconnecter.raison).toBe(
    'Un agent local ne perd pas son suivi sans s’arrêter.',
  );
});

test('D147 : un agent PTY ou sans session ne se reprend pas ; le transfert reste', () => {
  expect(possibles(local({ reprenable: false }))).toMatchObject({
    reprendre: false,
    defaut: 'transferer',
  });
  expect(optionsReprise(local({ session: false })).reprendre.raison).toContain('Aucune session');
  expect(possibles(local({ sujetOuvert: false }))).toMatchObject({
    reprendre: false,
    transferer: false,
    defaut: null,
  });
});

test('D147 : un processus de serveur vivant se rattache, et ne se relance jamais', () => {
  expect(possibles(serveur({ processus: 'vivant' }))).toEqual({
    reconnecter: true,
    reprendre: false,
    transferer: false,
    defaut: 'reconnecter',
  });
  expect(optionsReprise(serveur({ processus: 'vivant' })).reprendre.raison).toBe(
    'Le processus répond : le relancer couperait son tour.',
  );
});

test('D147 : processus arrêté, injoignable, ou sonde en cours', () => {
  expect(possibles(serveur())).toMatchObject({
    reconnecter: false,
    reprendre: true,
    defaut: 'reprendre',
  });
  expect(possibles(serveur({ session: false }))).toMatchObject({ reprendre: false, defaut: null });
  expect(possibles(serveur({ processus: 'injoignable' }))).toMatchObject({
    reconnecter: false,
    reprendre: false,
    defaut: null,
  });
  expect(possibles(serveur({ processus: null }))).toMatchObject({
    reconnecter: false,
    reprendre: false,
    defaut: null,
  });
  expect(optionsReprise(serveur()).transferer.raison).toBe(
    'Le transfert ne vaut que pour un sujet local.',
  );
});

test('D146 : le constat suit l’état, le bouton suit le choix', () => {
  expect(titreReprise(serveur())).toBe('Le suivi de claude est coupé.');
  expect(titreReprise(serveur({ suivi: 'echec' }))).toBe('La session de claude est perdue.');
  expect(titreReprise(local({ kind: 'codex' }))).toBe('codex est arrêté.');
  expect(boutonReprise('reconnecter')).toBe('Reconnecter');
  expect(boutonReprise('reprendre')).toBe('Reprendre la session');
  expect(boutonReprise('transferer', 'codex')).toBe('Transférer à codex');
});

test('D149 : l’alerte de transfert, commits non poussés et fichiers non commités', () => {
  expect(alerteTransfert({ nonPousses: 0, dirty: false })).toEqual({
    nonPousses: null,
    nonCommites: null,
  });
  expect(alerteTransfert({ nonPousses: 1, dirty: false }).nonPousses).toBe('1 commit non poussé.');
  expect(alerteTransfert({ nonPousses: 3, dirty: true })).toEqual({
    nonPousses: '3 commits non poussés.',
    nonCommites: 'Des fichiers ne sont pas commités : le nouvel agent les verra, sans leur raison.',
  });
});

test('D149 : le message de transfert repart de git et des pages, pas de la conversation', () => {
  const m = messageTransfert({
    ancien: 'claude',
    git: {
      branche: 'feat/x',
      base: 'main',
      commits: ['Ajoute x', 'Teste x'],
      nonPousses: 1,
      dirty: true,
    },
    pages: ['aid/plan/x', 'aid/dev-handoff/x'],
  });
  expect(m.split('\n')).toEqual([
    'Tu reprends ce sujet après claude. La conversation de l’agent précédent ne te suit pas.',
    'Branche feat/x, base main.',
    'Commits depuis main :',
    '- Ajoute x',
    '- Teste x',
    'Des fichiers ne sont pas commités : regarde git status.',
    'Lis d’abord les pages mémoire : aid/plan/x, aid/dev-handoff/x.',
    'Dis ce que tu comprends de l’état du travail avant de modifier quoi que ce soit.',
  ]);
  expect(
    messageTransfert({
      ancien: 'codex',
      git: { branche: 'feat/y', base: 'main', commits: [], nonPousses: 0, dirty: false },
      pages: [],
    }),
  ).toContain('Aucun commit depuis main.');
});
