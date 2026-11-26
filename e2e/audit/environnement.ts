import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, type Browser, type Page } from '@playwright/test';
import { createTopic, newRepo, registerWorkspace } from '../helpers.js';
import { preparerMeshes } from '../helpers-multi-mesh.js';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from '../host-helpers.js';
import type { Observation } from './classement.js';
import { appartientAuDaemonAudit } from './identite-processus.js';
import { runningDaemon } from '../../src/cli/daemonInfo.js';
import type { AidPaths } from '../../src/daemon/paths.js';
import { NOM_E2E, ouvrirServeLocal } from '../serve-local.js';

export const PORT_AUDIT = Number(process.env.AID_E2E_PORT ?? 4871) + 40;
const FRONTAL = PORT_AUDIT + 30;
const PORT_RELAIS = PORT_AUDIT + 32;
const FRONTAL_RELAIS = PORT_AUDIT + 31;
const RELAIS = 'https://relais.aid-e2e.example';
const CLI = join(import.meta.dirname, '../../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../../test/fixtures');

export const optionsNavigateur = {
  args: [
    `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}, MAP relais.aid-e2e.example:443 127.0.0.1:${FRONTAL_RELAIS}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
  ],
};

export interface Ecran {
  nom: string;
  chemin: string;
  page: Page;
}

/** Même harnais pour l'essai CI et l'audit complet ; tous les services extérieurs sont locaux. */
export async function preparerAudit(
  browser: Browser,
  options: {
    apresPreparation?: (ressources: { home: string; dossier: string }) => Promise<void>;
  } = {},
) {
  const faux = await preparerMeshes(['principal']);
  const bin = join(faux.dossier, 'bin');
  const env = {
    // Le watcher de mise à jour ne doit jamais contacter le remote du dépôt du chantier.
    GIT_ALLOW_PROTOCOL: 'file',
    SWARPH_SELF: undefined,
    MESH_GATEWAY_URL: undefined,
    AID_GH_BIN: join(FIXTURES, 'fake-gh.sh'),
    FAKE_GH_PR_URL: 'https://example.com/depot/pull/7',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(join(import.meta.dirname, '../pda-fetch.mjs')).href}`,
    AID_E2E_RELAIS_PORT: String(PORT_RELAIS),
  };
  const chemin = `${bin}${delimiter}${process.env.PATH}`;
  const configuration = `agents:\n  transport: pty\nswairm:\n  bin: ${join(FIXTURES, 'fake-swairm.sh')}`;
  let home = '';
  let relais: ChildProcess | undefined;
  const frontaux: Awaited<ReturnType<typeof ouvrirServeLocal>>[] = [];
  const connexions = new Set<Duplex>();
  const ajouterFrontal = (frontal: (typeof frontaux)[number]) => {
    frontaux.push(frontal);
    // closeAllConnections ne ferme pas les connexions promues en WebSocket.
    frontal.on('connection', (connexion) => {
      connexions.add(connexion);
      connexion.once('close', () => connexions.delete(connexion));
    });
  };
  const contextes: Awaited<ReturnType<Browser['newContext']>>[] = [];
  const portsDaemonLibres = async () =>
    (
      await Promise.all(
        [PORT_AUDIT, PORT_AUDIT + 10, PORT_AUDIT + 20].map(
          (port) =>
            new Promise<boolean>((resolve) => {
              const serveur = createServer();
              serveur.once('error', () => resolve(false));
              serveur.listen(port, '127.0.0.1', () => serveur.close(() => resolve(true)));
            }),
        ),
      )
    ).every(Boolean);
  const arreter = async () => {
    let info: { pid: number; token: string } | undefined;
    try {
      if (home) info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
    } catch {
      // Un démarrage avorté peut ne pas avoir écrit daemon.json.
    }
    if (info) {
      try {
        await fetch(`http://127.0.0.1:${PORT_AUDIT}/api/daemon/stop`, {
          method: 'POST',
          headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // Le processus peut déjà être arrêté ; les ports sont l'autorité ci-dessous.
      }
    }
    const attendre = async () => {
      const fin = Date.now() + 3000;
      while (!(await portsDaemonLibres()) && Date.now() < fin)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return portsDaemonLibres();
    };
    if (await attendre()) return;
    if (info) {
      if (!appartientAuDaemonAudit(info.pid, home))
        throw new Error('Ports du daemon audit encore occupés');
      try {
        process.kill(info.pid, 'SIGKILL');
      } catch (erreur) {
        if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
      }
    }
    if (!(await attendre())) throw new Error('Ports du daemon audit encore occupés');
  };
  const redemarrer = async () => {
    // Reprendre la configuration sauvegardée, sans que demarrerHost ne la réécrive.
    // R5 : la sortie va dans un fichier, pas dans un tube que le daemon détaché garderait
    // ouvert, pour qu'un échec dise pourquoi.
    const journal = join(home, 'redemarrage.log');
    const sortie = openSync(journal, 'w');
    const chemins = { daemonJson: join(home, 'daemon.json') } as AidPaths;
    try {
      execFileSync(process.execPath, [CLI], {
        env: {
          ...process.env,
          ...env,
          AID_HOME: home,
          AID_NO_BROWSER: '1',
          SHELL: '/bin/sh',
          PATH: chemin,
        },
        timeout: 90_000,
        stdio: ['ignore', sortie, sortie],
      });
    } catch (erreur) {
      // La CLI renonce après 10 s, mais le daemon détaché continue de démarrer : sur un
      // runner chargé, il répond souvent juste après. On lui laisse 60 s de plus.
      let info = null;
      for (let fin = Date.now() + 60_000; !info && Date.now() < fin;) {
        await new Promise((r) => setTimeout(r, 250));
        info = await runningDaemon(chemins);
      }
      if (!info) {
        const lire = (nom: string) => {
          try {
            return readFileSync(join(home, nom), 'utf8').slice(-2000);
          } catch {
            return '(illisible)';
          }
        };
        throw new Error(
          `redémarrage du daemon audit en échec : ${(erreur as Error).message}\n${lire('redemarrage.log')}\n--- daemon.log ---\n${lire('daemon.log')}`,
        );
      }
    } finally {
      closeSync(sortie);
    }
    return (JSON.parse(readFileSync(chemins.daemonJson, 'utf8')) as { token: string }).token;
  };
  const fermer = async () => {
    // Un contexte déjà fermé ou un frontal défaillant ne doit retenir aucun autre port.
    for (const connexion of connexions) connexion.destroy();
    const resultats = await Promise.allSettled([
      ...contextes.map((c) => c.close()),
      ...frontaux.map(async (frontal) => {
        frontal.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          frontal.close((erreur) => (erreur ? reject(erreur) : resolve())),
        );
      }),
      faux.fermer(),
    ]);
    // Le daemon et le relais sont les derniers, même si le nettoyage précédent échoue.
    resultats.push(
      ...(await Promise.allSettled([
        Promise.resolve().then(arreter),
        (async () => {
          if (!relais || relais.exitCode !== null || relais.signalCode !== null) return;
          const fin = once(relais, 'exit');
          const delai = setTimeout(() => relais?.kill('SIGKILL'), 3000);
          try {
            relais.kill('SIGTERM');
            await fin;
          } finally {
            clearTimeout(delai);
          }
        })(),
      ])),
    );
    // Garder les preuves et les fichiers ouverts si le daemon retient encore un port.
    if (await portsDaemonLibres()) {
      resultats.push(
        ...(await Promise.allSettled([
          Promise.resolve().then(() => {
            if (home) rmSync(home, { recursive: true, force: true });
          }),
          Promise.resolve().then(() => rmSync(faux.dossier, { recursive: true, force: true })),
        ])),
      );
    }
    const echecs = resultats.filter((r) => r.status === 'rejected');
    if (echecs.length)
      throw new AggregateError(
        echecs.map((r) => r.reason),
        'Nettoyage audit',
      );
  };
  try {
    home = mkdtempSync(join(tmpdir(), 'aid-audit-host-'));
    const archive = readFileSync(join(FIXTURES, 'swairm/ask-ok.json'), 'utf8');
    const { id } = JSON.parse(archive) as { id: string };
    mkdirSync(join(home, 'avis'));
    writeFileSync(join(home, 'avis', `${id}.json`), archive);
    mkdirSync(bin);
    for (const [nom, fichier] of Object.entries({
      claude: 'fake-agent.sh',
      codex: 'fake-agent.sh',
      gh: 'fake-gh.sh',
      swarph: 'fake-swarph.sh',
      swairm: 'fake-swairm.sh',
      tailscale: 'fake-tailscale.sh',
    }))
      writeFileSync(join(bin, nom), `#!/bin/sh\nexec '${join(FIXTURES, fichier)}' "$@"\n`, {
        mode: 0o700,
      });
    const instance = demarrerHost(PORT_AUDIT, faux.supplement, chemin, {
      home,
      env,
      configuration,
    });
    const origine = `http://127.0.0.1:${PORT_AUDIT}`;
    const contexte = await browser.newContext();
    contextes.push(contexte);
    // Ce garde interdit aussi les liens externes accidentels cliqués par l'audit.
    const garderReseau = async (contexte: (typeof contextes)[number]) => {
      await contexte.route('**/*', (route) => {
        const destination = new URL(route.request().url()).origin;
        return [origine, ORIGINE_APPAREIL, RELAIS].includes(destination)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
    };
    await garderReseau(contexte);
    await contexte.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    const mac = await contexte.newPage();
    await mac.goto(`${origine}/?token=${instance.token}`);
    await registerWorkspace(mac, newRepo('depot-audit'));
    const sujet = await createTopic(mac, 'Sujet audit');
    const etat = await mac.evaluate(async () => (await fetch('/api/state')).json());
    const worktree = etat.topics.find((t: { id: string }) => t.id === sujet).worktree as string;
    writeFileSync(join(worktree, 'audit.txt'), 'Contenu synthétique\n');
    // Commit exclusivement dans le dépôt jetable créé par newRepo, jamais dans le worktree du chantier.
    execFileSync('git', ['add', 'audit.txt'], { cwd: worktree });
    execFileSync(
      'git',
      ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'Fixture audit'],
      { cwd: worktree },
    );
    const serveur = await mac.evaluate(async () => {
      const r = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Serveur audit',
          mode: 'command',
          target: 'true',
          loadProfile: false,
        }),
      });
      if (!r.ok) throw new Error(`Création serveur : ${r.status}`);
      return ((await r.json()) as { id: string }).id;
    });
    const base = new Database(join(home, 'state.db'));
    try {
      const maintenant = new Date().toISOString();
      base
        .prepare(
          'INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sd_audit', serveur, 'Discussion audit', '~', maintenant, maintenant);
      base
        .prepare(
          `INSERT INTO server_agents (id, discussion_id, kind, status, permission_mode, created_at, updated_at)
         VALUES (?, ?, 'claude', 'stopped', 'default', ?, ?)`,
        )
        .run('sa_audit', 'sd_audit', maintenant, maintenant);
    } finally {
      base.close();
    }
    ajouterFrontal(await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT_AUDIT + 20 }));
    ajouterFrontal(
      await ouvrirServeLocal({ dir: home, port: FRONTAL_RELAIS, versPort: PORT_RELAIS }),
    );
    await mac.goto(`${origine}/machines`);
    const cle = await mac.evaluate(
      async () => (await (await fetch('/api/host/pda/cle')).json()).clePublique as string,
    );
    relais = spawn(
      process.execPath,
      [
        CLI,
        'relais',
        '--hote',
        '127.0.0.1',
        '--port',
        String(PORT_RELAIS),
        '--origine',
        ORIGINE_APPAREIL,
        '--cle-daemon',
        cle,
      ],
      { stdio: 'ignore' },
    );
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${PORT_RELAIS}/`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(404);
    await mac.getByLabel('Adresse du relais').fill(RELAIS);
    mac.once('dialog', (d) => d.accept());
    await mac.getByRole('switch', { name: 'PDA :' }).click();
    await expect(mac.getByRole('switch', { name: 'PDA :' })).toBeChecked();
    const appareil = await appairerHost(browser, mac, PORT_AUDIT, 'Appareil audit');
    contextes.push(appareil.context());
    await garderReseau(appareil.context());
    const cdp = await appareil.context().newCDPSession(appareil);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    await appareil.goto(`${ORIGINE_APPAREIL}/pda/enregistrer`);
    await appareil.getByLabel('Nom de cet appareil').fill('PDA audit');
    await appareil.getByRole('button', { name: 'Enregistrer cet appareil', exact: true }).click();
    await expect(appareil.locator('.pda-empreinte')).toBeVisible();
    await mac.reload();
    mac.once('dialog', (d) => d.accept());
    await mac
      .getByRole('listitem')
      .filter({ hasText: 'PDA audit' })
      .getByRole('button', { name: 'Activer', exact: true })
      .click();
    await mac.getByRole('button', { name: 'Envoyer une demande d’essai' }).click();
    await expect(mac.locator('[data-node="machines.pda.resultat"]')).toContainText(
      'Demande envoyée',
    );
    const routesMac = [
      '/',
      '/boite',
      '/consignes',
      '/reglages',
      '/swarph',
      '/swarph/cells',
      '/swarph/federation',
      '/swarph/memoire',
      '/swarph/reglages',
      '/board',
      '/board/cartes/101?mesh=principal',
      '/machines',
      '/serveurs',
      '/serveurs/nouveau',
      `/serveurs/${serveur}/configuration`,
      `/serveurs/${serveur}/discussion`,
      `/serveurs/${serveur}/discussions/sd_audit`,
      '/sujets/nouveau',
      `/sujets/${sujet}`,
      `/sujets/${sujet}/livraison`,
    ];
    const routesAppareil = [
      '/',
      '/sujets',
      `/sujets/${sujet}`,
      `/sujets/${sujet}/tour`,
      `/sujets/${sujet}/fichiers/0`,
      `/sujets/${sujet}/livraison`,
      '/informations',
      '/notifications',
      '/board',
      '/board/cartes/101?mesh=principal',
      '/appareils',
      '/appairer',
    ];
    // Vérifier les routes de repli sans auditer deux fois leur écran d'arrivée.
    await mac.goto(`${origine}/route-inconnue-audit`);
    await expect(mac).toHaveURL(`${origine}/`);
    await appareil.goto(`${ORIGINE_APPAREIL}/route-inconnue-audit`);
    await expect(appareil).toHaveURL(`${ORIGINE_APPAREIL}/`);
    const ecrans: Ecran[] = [
      ...routesAppareil.map((p) => ({
        nom: `appareil ${p}`,
        chemin: `${ORIGINE_APPAREIL}${p}`,
        page: appareil,
      })),
      ...['/pda', '/pda/enregistrer'].map((p) => ({
        nom: `PDA ${p}`,
        chemin: `${ORIGINE_APPAREIL}${p}`,
        page: appareil,
      })),
      ...routesMac.map((p) => ({ nom: `Mac ${p}`, chemin: `${origine}${p}`, page: mac })),
    ];
    // Sauvegarde cohérente de la fixture synthétique, avant toute action de l'explorateur.
    // Révoquer/couper un accès ne doit pas priver les écrans suivants de leur appareil.
    const sauvegarde = join(faux.dossier, 'etat-initial.db');
    const baseInitiale = new Database(join(home, 'state.db'));
    try {
      await baseInitiale.backup(sauvegarde);
    } finally {
      baseInitiale.close();
    }
    const fichiersInitiaux = new Map(
      ['config.yaml', 'pda-signature.pem'].map((nom) => [nom, readFileSync(join(home, nom))]),
    );
    const cookiesInitiaux = await Promise.all(contextes.map((c) => c.cookies()));
    const remettreANeuf = async () => {
      await arreter();
      for (const suffixe of ['-wal', '-shm'])
        rmSync(join(home, `state.db${suffixe}`), { force: true });
      copyFileSync(sauvegarde, join(home, 'state.db'));
      for (const [nom, contenu] of fichiersInitiaux) writeFileSync(join(home, nom), contenu);
      const token = await redemarrer();
      for (const [i, contexte] of contextes.entries()) {
        await contexte.clearCookies();
        await contexte.addCookies(cookiesInitiaux[i]!);
      }
      await mac.request.get(`${origine}/?token=${token}`);
    };
    const headers = { origin: origine, 'x-aid-cockpit': '1' };
    const instantFixture = new Date().toISOString();
    const preparerAgents = async () => {
      const etat = await (await mac.request.get(`${origine}/api/state`, { headers })).json();
      for (const kind of ['claude', 'codex']) {
        let agent = etat.agents.find(
          (a: { kind: string; status: string }) =>
            a.kind === kind && ['starting', 'working', 'needs_input', 'idle'].includes(a.status),
        );
        if (!agent) {
          const r = await mac.request.post(`${origine}/api/agents`, {
            headers,
            data: { topicId: sujet, kind },
          });
          if (!r.ok()) throw new Error(`Fixture agent : ${r.status()}`);
          agent = await r.json();
        }
        // Signal synthétique de fin de tour ; le processus derrière est bien le faux PTY vivant.
        const r = await mac.request.post(`${origine}/api/events`, {
          headers,
          data: {
            source: 'hook:claude',
            type: 'agent.status',
            agentId: agent.id,
            topicId: sujet,
            ts: instantFixture,
            data: { status: 'idle' },
          },
        });
        if (!r.ok()) throw new Error(`Fixture statut : ${r.status()}`);
      }
      const base = new Database(join(home, 'state.db'));
      try {
        base
          .prepare(
            'UPDATE mesh_inbox SET seen_at = NULL, decided_at = NULL WHERE mesh = ? AND id = ?',
          )
          .run('principal', 46);
        base.prepare('DELETE FROM tours_marques').run();
      } finally {
        base.close();
      }
    };
    await preparerAgents();
    const dossierAutorise = join(faux.dossier, 'dossier-autorise');
    mkdirSync(dossierAutorise);
    let creation = 0;
    let passageServeur = 0;
    let demandeEssai: string | undefined;
    const preparerAction = async (ecran: Ecran, element: { node: string | null }) => {
      const page = ecran.page;
      const champ = (id: string) => page.locator(`[data-node="${id}"]`);
      if (element.node === '1-1.consigne.envoyer')
        await champ('1-1.consigne.champ').fill('Consigne synthétique audit');
      if (element.node === 'serveur-config.dossier-ajouter')
        await champ('serveur-config.dossier').fill(dossierAutorise);
      if (element.node === 'serveur-config.enregistrer') {
        // Chaque création/configuration possède un nom libre, y compris entre les formats.
        await champ('serveur-config.nom').fill(`Serveur synthétique audit ${++passageServeur}`);
        await champ('serveur-config.mode-command').click();
        await champ('serveur-config.cible').fill('true');
      }
      if (element.node === 'nouveau-sujet.pied.creer') {
        await champ('nouveau-sujet.besoin.titre-sujet').fill(
          `Sujet synthétique audit ${++creation}`,
        );
        await champ('nouveau-sujet.travail.agent').selectOption('aucun');
      }
      if (element.node === 'pda.enregistrement.enregistrer')
        await champ('pda.enregistrement.nom').fill('Appareil synthétique audit');
      // Le renouvellement de l'essai change son id ; cibler la demande fraîche de cette action.
      if (ecran.nom === 'PDA /pda' && element.node?.startsWith('pda.demande.') && demandeEssai)
        element.node = element.node.replace(
          /^pda\.demande\.[^.]+\./,
          `pda.demande.${demandeEssai}.`,
        );
      if (element.node?.startsWith('pda.demande.') && element.node.endsWith('.confirmer')) {
        const section = champ(element.node).locator('xpath=ancestor::section[1]');
        await section
          .locator('input')
          .fill((await section.locator('.pda-numero').textContent())!.trim());
      }
    };
    const apresAction = async (
      ecran: Ecran,
      element: { node: string | null },
      observation: Observation,
    ) => {
      if (
        ecran.nom !== 'PDA /pda' ||
        !element.node?.startsWith('pda.demande.') ||
        observation.echecClic ||
        observation.cibleDisparue ||
        observation.dialogueAnnule
      )
        return;
      const etat = element.node.endsWith('.confirmer')
        ? 'confirmee'
        : element.node.endsWith('.refuser')
          ? 'refusee'
          : null;
      if (!etat) return;
      const id = element.node.split('.')[2]!;
      // L'acquittement du relais précède le traitement par le daemon : attendre avant d'annuler.
      await expect
        .poll(async () => {
          const resultat = await mac.request.get(`${origine}/api/host/pda/demandes/${id}`, {
            headers,
          });
          return (await resultat.json()).etat;
        })
        .toBe(etat);
    };
    const preferences = await mac.evaluate(
      async () => (await (await fetch('/api/nav')).json()).prefs,
    );
    const stockages = new Map<Page, Record<string, string>>();
    for (const page of [mac, appareil])
      stockages.set(page, await page.evaluate(() => ({ ...localStorage })));
    const reinitialiser = async (ecran: Ecran) => {
      const appareils = await mac.request.get(`${origine}/api/host/appareils`, { headers });
      const host = await mac.request.get(`${origine}/api/host`, { headers });
      if (
        !(await host.json()).actif ||
        (await appareils.json()).some(
          (a: { nom: string; etat: string }) => a.nom === 'Appareil audit' && a.etat !== 'actif',
        )
      ) {
        await remettreANeuf();
      }
      if (!(await (await mac.request.get(`${origine}/api/host`, { headers })).json()).actif) {
        const reponse = await mac.request.put(`${origine}/api/host`, {
          headers,
          data: { actif: true },
        });
        if (!reponse.ok()) throw new Error(`Restauration host : ${reponse.status()}`);
      }
      await preparerAgents();
      const nav = await mac.request.patch(`${origine}/api/nav/prefs`, {
        headers,
        data: preferences,
      });
      if (!nav.ok()) throw new Error(`Restauration préférences : ${nav.status()}`);
      if (ecran.nom.includes('/discussion')) {
        const panneau = await mac.request.put(`${origine}/api/servers/${serveur}/panel`, {
          headers,
          data: { open: true, tab: 'files' },
        });
        if (!panneau.ok()) throw new Error(`Restauration panneau : ${panneau.status()}`);
      }
      if (ecran.nom === 'PDA /pda') {
        // D210 expire les demandes à la reprise du daemon : ne jamais réutiliser l'essai initial.
        const file = await mac.request.get(`${origine}/api/confirmations`, { headers });
        if (!file.ok()) throw new Error(`Lecture des essais PDA : ${file.status()}`);
        const ouvertes = (await file.json()).ouvertes as Array<{ id: string; action: string }>;
        for (const demande of ouvertes.filter((d) => d.action === 'essai')) {
          const annulation = await mac.request.delete(
            `${origine}/api/confirmations/${demande.id}`,
            { headers },
          );
          if (!annulation.ok() && annulation.status() !== 409)
            throw new Error(`Annulation essai PDA : ${annulation.status()}`);
        }
        const essai = await mac.request.post(`${origine}/api/host/pda/essai`, { headers });
        if (!essai.ok()) throw new Error(`Nouvel essai PDA : ${essai.status()}`);
        demandeEssai = ((await essai.json()) as { id: string }).id;
      }
      await ecran.page.evaluate((stockage) => {
        localStorage.clear();
        for (const [cle, valeur] of Object.entries(stockage)) localStorage.setItem(cle, valeur);
      }, stockages.get(ecran.page)!);
    };
    await options.apresPreparation?.({ home, dossier: faux.dossier });
    return {
      ecrans,
      fermer,
      reinitialiser,
      preparerAction,
      apresAction,
      dossierAutorise,
      remettreANeuf,
      async verifierDaemon() {
        try {
          // Toute réponse HTTP prouve que le daemon répond, même un refus d'accès.
          await fetch(origine, { signal: AbortSignal.timeout(3000) });
          return true;
        } catch {
          /* La vérification fait partie du relevé, puis redémarre le même home. */
        }
        try {
          await arreter();
        } catch {
          /* Déjà arrêté. */
        }
        const token = await redemarrer();
        await mac.request.get(`${origine}/?token=${token}`);
        return false;
      },
    };
  } catch (erreur) {
    try {
      await fermer();
    } catch (nettoyage) {
      throw new AggregateError([erreur, nettoyage], 'Préparation et nettoyage audit');
    }
    throw erreur;
  }
}
