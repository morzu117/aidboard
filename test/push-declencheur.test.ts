import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { migrate } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { creerDeclencheur } from '../src/daemon/push/declencheur.js';
import type { ResultatEnvoi } from '../src/daemon/push/envoi.js';

const nettoyages: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
  vi.useRealTimers();
});

function preparer(compterPda?: () => number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(`
    INSERT INTO workspaces (id,name,root,base_branch,worktrees_dir,created_at)
      VALUES ('w','Exemple','/tmp/exemple','main','/tmp/exemple-w','t');
    INSERT INTO topics (id,workspace_id,slug,title,type,branch,base,worktree,state,index_state,created_at,updated_at)
      VALUES ('t','w','exemple','Exemple','feat','feat/exemple','main','/tmp/exemple-w','active','disabled','t','t');
    INSERT INTO runs VALUES ('r','t','standard','open','t');
  `);
  const store = new EventStore(db);
  const registre = new RegistreAppareils(db);
  function abonner() {
    const { appareil } = registre.emettre({ nom: 'Exemple', identite: null });
    db.prepare('INSERT INTO push_abonnements VALUES (?, ?, ?, ?, ?)').run(
      appareil.id,
      'https://example.com/MARQUEUR-ENDPOINT',
      'cle',
      'auth',
      new Date().toISOString(),
    );
    return appareil.id;
  }
  const appareilId = abonner();
  const envoyer = vi.fn(async (): Promise<ResultatEnvoi> => ({ statut: 'ok' }));
  const log = vi.fn();
  const config = { host: true, push: true };
  const declencheur = creerDeclencheur({
    compterPda,
    db,
    store,
    log,
    actif: () => config.host && config.push,
    envoi: () => ({
      clesVapid: {
        clePubliqueBase64url: () => '',
        jetonVapid: () => '',
        enTeteAuthorization: () => '',
      },
    }),
    envoyer,
    maintenant: Date.now,
    programmer: setTimeout,
    annuler: clearTimeout,
  });
  nettoyages.push(async () => {
    await declencheur.arreter();
    db.close();
  });
  let sequence = 0;
  function ajouter(kind: 'question' | 'permission' | 'tour' = 'question') {
    const id = `a${++sequence}`;
    db.prepare(
      `INSERT INTO agents (id,run_id,kind,role,transport,status,cwd,command,created_at,updated_at,pending,status_reason)
      VALUES (?, 'r', 'claude', 'free', 'pty', ?, '/tmp/exemple', '[]', 't', 't', ?, ?)`,
    ).run(
      id,
      kind === 'tour' ? 'idle' : 'needs_input',
      kind === 'tour' ? null : JSON.stringify({ id, kind }),
      kind === 'tour' ? null : kind,
    );
    signaler();
    return id;
  }
  function signaler() {
    store.append({ source: 'daemon', type: 'agent.tool', data: {} });
  }
  function retirer(id: string) {
    db.prepare('UPDATE agents SET pending = NULL, status_reason = NULL WHERE id = ?').run(id);
    signaler();
  }
  return {
    db,
    store,
    log,
    config,
    envoyer,
    ajouter,
    retirer,
    signaler,
    declencheur,
    appareilId,
    abonner,
  };
}

test('une question envoie immédiatement n = 1 et journalise sans endpoint', async () => {
  const t = preparer();
  t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(1);
  expect(t.envoyer.mock.calls[0]).toEqual([expect.anything(), 1, expect.anything()]);
  await Promise.resolve();
  const journal = t.store.since(null).filter((e) => e.type === 'push.envoye');
  expect(journal).toHaveLength(1);
  expect(journal[0]!.data).toEqual({ appareilId: t.appareilId, statut: 'ok' });
  expect(JSON.stringify(journal)).not.toContain('MARQUEUR-ENDPOINT');
});

test('trois questions en dix secondes donnent deux envois, n = 1 puis n = 3', async () => {
  const t = preparer();
  t.ajouter();
  await vi.advanceTimersByTimeAsync(5000);
  t.ajouter();
  await vi.advanceTimersByTimeAsync(5000);
  t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(t.envoyer).toHaveBeenCalledTimes(2);
  expect(t.envoyer.mock.calls[1]).toEqual([expect.anything(), 3, expect.anything()]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.envoyer).toHaveBeenCalledTimes(2);
});

test('une permission compte aussi, un tour ne compte pas', () => {
  const t = preparer();
  t.ajouter('tour');
  expect(t.envoyer).not.toHaveBeenCalled();
  t.ajouter('permission');
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test('les baisses de 2 à 1 et à zéro, les valeurs égales ne déclenchent rien', async () => {
  const t = preparer();
  const a = t.ajouter();
  const b = t.ajouter();
  await vi.advanceTimersByTimeAsync(30_000);
  t.retirer(a);
  t.signaler();
  await vi.advanceTimersByTimeAsync(30_000);
  t.retirer(b);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.envoyer).toHaveBeenCalledTimes(2);
});

test.each(['host', 'push'] as const)('interrupteur %s relu à chaque hausse', (reglage) => {
  const t = preparer();
  t.config[reglage] = false;
  t.ajouter();
  expect(t.envoyer).not.toHaveBeenCalled();
  t.config[reglage] = true;
  t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test('la coupure pendant une fenêtre empêche son envoi final', async () => {
  const t = preparer();
  t.ajouter();
  t.ajouter();
  t.config.push = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test.each(['expire', 'echec'] as const)(
  '%s : seul expire supprime l’abonnement',
  async (statut) => {
    const t = preparer();
    t.envoyer.mockResolvedValue({ statut });
    t.ajouter();
    await Promise.resolve();
    expect(t.db.prepare('SELECT * FROM push_abonnements').all()).toHaveLength(
      statut === 'expire' ? 0 : 1,
    );
  },
);

test('un abonnement lent ne bloque ni les autres ni le journal', async () => {
  const t = preparer();
  const autre = t.abonner();
  let terminer!: (r: ResultatEnvoi) => void;
  t.envoyer.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        terminer = resolve;
      }),
  );
  t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(t.store.since(null).find((e) => e.type === 'push.envoye')?.data.appareilId).toBe(autre);
  terminer({ statut: 'ok' });
});

test('l’arrêt nettoie la minuterie et désabonne le store', async () => {
  const t = preparer();
  t.ajouter();
  t.ajouter();
  expect(vi.getTimerCount()).toBe(1);
  await t.declencheur.arreter();
  expect(vi.getTimerCount()).toBe(0);
  expect(t.store.listenerCount('event')).toBe(0);
  t.ajouter();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test('une fenêtre revenue à zéro n’envoie rien', async () => {
  const t = preparer();
  const a = t.ajouter();
  const b = t.ajouter();
  t.retirer(a);
  t.retirer(b);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test('une hausse revenue au nombre déjà envoyé ne renvoie rien en fin de fenêtre', async () => {
  const t = preparer();
  const a = t.ajouter();
  t.retirer(a);
  t.ajouter();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.envoyer).toHaveBeenCalledTimes(1);
});

test('les agents fermés et les sujets archivés restent hors du compteur', () => {
  const t = preparer();
  t.config.push = false;
  const a = t.ajouter();
  t.db.prepare('UPDATE agents SET closed_at = ? WHERE id = ?').run('t', a);
  t.signaler();
  t.db.prepare("UPDATE topics SET state = 'archived'").run();
  t.config.push = true;
  t.ajouter();
  expect(t.envoyer).not.toHaveBeenCalled();
});

test('32b.11 : JSON invalide isolé dans l’observateur et la minuterie, puis reprise', async () => {
  const t = preparer();
  t.config.push = false;
  const id = t.ajouter();
  t.retirer(id);
  t.db.prepare('UPDATE agents SET pending = ? WHERE id = ?').run('invalide', id);
  expect(() => t.signaler()).not.toThrow();
  expect(t.log).toHaveBeenCalledWith('Erreur du compteur push');
  t.retirer(id);
  t.config.push = true;
  const suivant = t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  t.db.prepare('UPDATE agents SET pending = ? WHERE id = ?').run('invalide', suivant);
  await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
  expect(t.log).toHaveBeenCalledTimes(2);
  t.retirer(suivant);
  t.ajouter();
  expect(t.envoyer).toHaveBeenCalledTimes(2);
});

test('le signal PDA partage le regroupement et le compteur des décisions', async () => {
  let ouvertes = 0;
  const t = preparer(() => ouvertes);
  ouvertes = 1;
  t.declencheur.signaler();
  await Promise.resolve();
  expect(t.envoyer).toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
  t.ajouter();
  ouvertes = 2;
  t.declencheur.signaler();
  expect(t.envoyer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(t.envoyer).toHaveBeenLastCalledWith(expect.anything(), 3, expect.anything());
});

test('un nouveau PDA réveille aussi après la clôture du précédent', async () => {
  let ouvertes = 0;
  const t = preparer(() => ouvertes);
  ouvertes = 1;
  t.declencheur.signaler();
  ouvertes = 0;
  t.declencheur.signaler();
  await vi.advanceTimersByTimeAsync(30_000);
  ouvertes = 1;
  t.declencheur.signaler();
  expect(t.envoyer).toHaveBeenCalledTimes(2);
});
