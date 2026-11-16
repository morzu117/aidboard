import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, type Browser, type Page } from '@playwright/test';
import { createTopic, newRepo, registerWorkspace } from '../helpers.js';
import { preparerMeshes } from '../helpers-multi-mesh.js';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from '../host-helpers.js';
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
export async function preparerAudit(browser: Browser) {
  const faux = await preparerMeshes(['principal']);
  const bin = join(faux.dossier, 'bin');
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
  const contextes: Awaited<ReturnType<Browser['newContext']>>[] = [];
  const arreter = () => {
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
        stdio: 'ignore',
      });
  };
  const fermer = async () => {
    await Promise.all(contextes.map((c) => c.close()));
    if (relais && relais.exitCode === null) {
      const fin = once(relais, 'exit');
      relais.kill('SIGTERM');
      await fin;
    }
    for (const frontal of frontaux) {
      frontal.closeAllConnections();
      await new Promise<void>((resolve) => frontal.close(() => resolve()));
    }
    try {
      arreter();
    } finally {
      await faux.fermer();
    }
  };
  try {
    const instance = demarrerHost(PORT_AUDIT, faux.supplement, chemin, { env, configuration });
    home = instance.home;
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
    frontaux.push(await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT_AUDIT + 20 }));
    frontaux.push(
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
    await mac.getByLabel('Sujet', { exact: true }).fill('Demande synthétique');
    await mac.getByRole('button', { name: 'Envoyer une demande d’essai' }).click();
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
      '/route-inconnue-audit',
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
      '/route-inconnue-audit',
    ];
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
    return {
      ecrans,
      fermer,
      async verifierDaemon() {
        try {
          // Toute réponse HTTP prouve que le daemon répond, même un refus d'accès.
          await fetch(origine, { signal: AbortSignal.timeout(3000) });
          return true;
        } catch {
          /* La vérification fait partie du relevé, puis redémarre le même home. */
        }
        try {
          arreter();
        } catch {
          /* Déjà arrêté. */
        }
        const nouvelleInstance = demarrerHost(PORT_AUDIT, faux.supplement, chemin, {
          home,
          env,
          configuration,
        });
        await mac.request.get(`${origine}/?token=${nouvelleInstance.token}`);
        return false;
      },
    };
  } catch (erreur) {
    await fermer();
    throw erreur;
  }
}
