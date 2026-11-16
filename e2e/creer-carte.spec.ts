import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes, node } from './helpers.js';
import { capturerBoutons } from './captures-boutons.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 18;
const FRONTAL = PORT + 30;
const FRONTAL_RELAIS = PORT + 31;
const RELAIS = 'https://relais.aid-e2e.example';
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}, MAP relais.aid-e2e.example:443 127.0.0.1:${FRONTAL_RELAIS}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  },
});

async function portLibre() {
  const serveur = createServer();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = (serveur.address() as { port: number }).port;
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
  return port;
}
async function fermer(serveur?: Server) {
  if (!serveur) return;
  serveur.closeAllConnections();
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
}
async function arreter(relais?: ChildProcess) {
  if (!relais || relais.exitCode !== null) return;
  const fin = once(relais, 'exit');
  relais.kill('SIGTERM');
  await fin;
}

for (const doublon of [false, true]) {
  test(
    doublon
      ? 'Créer la carte : doublon dans un autre projet après aperçu'
      : 'Créer la carte : confirmation et sujet relié',
    async ({ browser }) => {
      test.setTimeout(180_000);
      let home = '';
      let frontal: Server | undefined;
      let frontalRelais: Server | undefined;
      let relais: ChildProcess | undefined;
      const dossier = mkdtempSync(join(tmpdir(), 'aid-e2e-creer-carte-'));
      const socket = join(dossier, 'proxy.sock');
      const swairm = join(dossier, 'swairm.mjs');
      const ligneSwairm = 'Swairm: owner-a/depot-a#sans';
      const titre = 'Sujet sans carte';
      const date = '2026-11-15T10:00:00Z';
      writeFileSync(
        swairm,
        `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['status', '--json'])) process.exit(2);
process.stdout.write(${JSON.stringify(
          JSON.stringify({
            format: 'swairm-status/1',
            projets: [
              {
                projet: 'owner-a/depot-a',
                sujets: [
                  {
                    id: 'sans',
                    titre,
                    etat: 'planned',
                    colonne: 'travail',
                    en_pause: false,
                    pas: { total: 1, par_etat: { todo: 1 } },
                    maj: date,
                  },
                ],
                vols: [],
              },
            ],
            erreurs: [],
          }),
        )});
`,
        { mode: 0o700 },
      );
      const fixtures = join(import.meta.dirname, '../test/fixtures/board');
      const projets = JSON.parse(readFileSync(join(fixtures, 'projects-list.json'), 'utf8'));
      projets.projects.push({
        ...projets.projects[0],
        id: 43,
        slug: 'autre-projet',
        title: 'Autre projet',
      });
      const modele = JSON.parse(readFileSync(join(fixtures, 'cards-list-42.json'), 'utf8'))
        .cards[0];
      const cartes: Array<typeof modele> = [];
      const creations: Array<{ verb: string; args: Record<string, unknown> }> = [];
      const recherches: Array<Record<string, unknown>> = [];
      const notes: Array<Record<string, unknown>> = [];
      let refuserNote = true;
      const proxy = createServer((connexion) => {
        connexion.on('error', () => undefined);
        let tampon = '';
        connexion.on('data', (morceau) => {
          tampon += morceau.toString();
          if (!tampon.includes('\n')) return;
          const requete = JSON.parse(tampon.split('\n')[0]!);
          const { verb, args } = requete;
          let body: unknown;
          if (verb === 'board.projects.list') body = projets;
          else if (verb === 'board.cards.list') {
            if (args.q) recherches.push(args);
            body = {
              cards: cartes.filter(
                (carte) =>
                  (!args.project || carte.project_id === args.project) &&
                  (!args.q || `${carte.title}\n${carte.body}`.includes(args.q)),
              ),
              searched: cartes.length,
            };
          } else if (verb === 'board.card.get') {
            body = {
              ...JSON.parse(readFileSync(join(fixtures, 'cards-show-101.json'), 'utf8')),
              ...cartes.find((c) => c.id === args.id),
            };
          } else if (verb === 'board.cards.graph' || verb === 'board.cards.thread') {
            body = JSON.parse(
              readFileSync(
                join(
                  fixtures,
                  verb.endsWith('graph') ? 'cards-graph-101.json' : 'cards-thread-101.json',
                ),
                'utf8',
              ),
            );
          } else if (verb === 'board.obligations.list') {
            body = { obligations: [] };
          } else if (verb === 'board.cards.say') {
            if (!refuserNote) notes.push(requete);
            body = { id: 105, open_obligations: [], closed_obligations: [] };
          } else if (verb === 'board.cards.create') {
            creations.push(requete);
            const carte = {
              ...modele,
              id: 103,
              project_id: args.project,
              title: args.title,
              body: args.body,
            };
            cartes.push(carte);
            body = carte;
          }
          connexion.end(
            JSON.stringify({
              request_id: requete.request_id,
              ...(verb === 'board.cards.say' && refuserNote
                ? { ok: false, error: 'upstream_error', status: 403 }
                : body === undefined
                  ? { ok: false, error: 'verb_not_allowed' }
                  : { ok: true, status: 200, body }),
            }) + '\n',
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(socket, resolve);
      });
      const portRelais = await portLibre();
      try {
        const ancien = process.env.NODE_OPTIONS;
        const ancienPort = process.env.AID_E2E_RELAIS_PORT;
        let instance: ReturnType<typeof demarrerHost>;
        try {
          process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`;
          process.env.AID_E2E_RELAIS_PORT = String(portRelais);
          instance = demarrerHost(
            PORT,
            `  bin: ${join(import.meta.dirname, '../test/fixtures/fake-swarph.sh')}
  cell: peer-a
  gateway: https://example.com
  proxySocket: ${socket}
  inboxLog: ${join(dossier, 'inbox.log')}
  proxyLectureSeule: false
swairm:
  bin: ${swairm}`,
          );
          home = instance.home;
        } finally {
          if (ancien === undefined) delete process.env.NODE_OPTIONS;
          else process.env.NODE_OPTIONS = ancien;
          if (ancienPort === undefined) delete process.env.AID_E2E_RELAIS_PORT;
          else process.env.AID_E2E_RELAIS_PORT = ancienPort;
        }
        frontal = await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT + 20 });
        frontalRelais = await ouvrirServeLocal({
          dir: home,
          port: FRONTAL_RELAIS,
          versPort: portRelais,
        });
        const mac = await (await browser.newContext()).newPage();
        await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
        await mac.goto(`http://127.0.0.1:${PORT}/machines`);
        const lancerRelais = async () => {
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
              String(portRelais),
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
                return (await fetch(`http://127.0.0.1:${portRelais}/`)).status;
              } catch {
                return 0;
              }
            })
            .toBe(404);
        };
        await lancerRelais();
        await mac.getByLabel('Adresse du relais').fill(RELAIS);
        mac.once('dialog', (d) => d.accept());
        await mac.getByRole('switch', { name: 'PDA :' }).click();
        await expect(mac.getByRole('switch', { name: 'PDA :' })).toBeChecked();
        const telephone = await appairerHost(browser, mac, PORT, 'Téléphone PDA');
        const cdp = await telephone.context().newCDPSession(telephone);
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
        const enregistrer = async (nom: string) => {
          await telephone.goto(`${ORIGINE_APPAREIL}/pda/enregistrer`);
          await telephone.getByLabel('Nom de cet appareil').fill(nom);
          await telephone
            .getByRole('button', { name: 'Enregistrer cet appareil', exact: true })
            .click();
          await expect(telephone.locator('.pda-empreinte')).toBeVisible();
          const empreinte = (await telephone.locator('.pda-empreinte').textContent())!;
          await mac.reload();
          const ligne = mac.getByRole('listitem').filter({ hasText: nom });
          await expect(ligne.locator('code')).toHaveText(empreinte);
          mac.once('dialog', async (d) => {
            expect(d.message()).toContain(empreinte);
            await d.accept();
          });
          await ligne.getByRole('button', { name: 'Activer', exact: true }).click();
          await expect(ligne.getByText('actif', { exact: true })).toBeVisible();
          await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
        };
        await enregistrer('PDA recette');
        const origine = `http://127.0.0.1:${PORT}`;
        await mac.goto(`${origine}/board`);
        await expect(node(mac, 'board.identite')).toContainText('confirmation sur le téléphone');
        await expect(node(mac, 'board.identite')).not.toContainText('Lecture seule');
        await capturerBoutons(mac, '56-6-board-mac', node(mac, 'board.identite'));
        await telephone.goto(`${ORIGINE_APPAREIL}/board`);
        await expect(node(telephone, 'board.identite')).toContainText('Lecture seule');
        await capturerBoutons(telephone, '56-6-board-appareil', node(telephone, 'board.identite'));
        const sansCarte = mac.locator('details').filter({ hasText: 'Sujets Swairm sans carte' });
        await expect(sansCarte.locator('summary')).toHaveText('Sujets Swairm sans carte (1)');
        await sansCarte.locator('summary').click();
        await expect(sansCarte.locator('li')).toContainText(
          'owner-a/depot-a#sans · Sujet sans carte',
        );
        await sansCarte.getByRole('button', { name: 'Créer la carte', exact: true }).click();
        const dialogue = mac.getByRole('dialog');
        const voir = dialogue.getByRole('button', { name: "Voir l'aperçu" });
        const apercu = dialogue.getByRole('region', { name: 'Aperçu' });
        await expect(dialogue.getByRole('combobox', { name: 'Projet', exact: true })).toHaveValue(
          '',
        );
        await expect(voir).toBeDisabled();
        await expect(apercu).toHaveCount(0);
        await expect(dialogue.getByLabel('Titre', { exact: true })).toHaveValue(titre);
        await dialogue.getByRole('combobox', { name: 'Projet', exact: true }).selectOption('42');
        await dialogue.getByLabel('Texte facultatif', { exact: true }).fill('Texte de recette.');
        await voir.click();
        const lignes = [
          'Titre : Sujet sans carte',
          'Projet : Projet de test (#42)',
          'Sujet : owner-a/depot-a#sans',
        ];
        for (const ligne of lignes) await expect(apercu).toContainText(ligne);
        await expect(apercu).toContainText(
          'Le board ouvrira aussi les obligations obligatoires du projet, sans détenteur. A-I-D ne pourra pas les retirer.',
        );
        if (doublon) {
          // Une autre cellule crée la carte après l'aperçu, dans un autre projet.
          cartes.push({ ...modele, id: 104, project_id: 43, stage: 'done', body: ligneSwairm });
        }
        const debutRecherches = recherches.length;
        const envoi = mac.waitForResponse(
          (r) => r.url().endsWith('/api/swarph/ecrire/envoyer') && r.request().method() === 'POST',
        );
        await apercu.getByRole('button', { name: 'Envoyer', exact: true }).click();
        expect((await envoi).status()).toBe(202);
        expect(creations).toEqual([]);
        const numero = mac.locator('strong').filter({ hasText: /^\d{4}$/ });
        await expect(numero).toBeVisible();
        const valeur = (await numero.textContent())!;
        await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
        await telephone.getByRole('button', { name: 'Actualiser' }).click();
        for (const ligne of lignes) await expect(telephone.locator('body')).toContainText(ligne);
        await telephone.getByLabel(/^Retape le numéro/).fill(valeur);
        await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
        await expect(
          dialogue
            .getByRole('status')
            .filter({ hasText: doublon ? 'Une carte porte déjà ce sujet' : 'Parti.' }),
        ).toBeVisible({ timeout: 35_000 });
        await expect(dialogue.getByRole('status')).toHaveCount(1);
        await expect(dialogue.getByText('Exécutée', { exact: true })).toHaveCount(0);
        await capturerBoutons(
          mac,
          doublon ? '56-6-creation-doublon' : '56-6-creation-fin',
          dialogue.getByRole('status'),
        );
        expect(recherches.slice(debutRecherches)).toContainEqual({ q: 'owner-a/depot-a#sans' });
        if (doublon) {
          expect(creations).toEqual([]);
          await expect(dialogue).toContainText(
            "Une carte porte déjà ce sujet : #104. Rien n'a été créé.",
          );
        } else {
          await expect(dialogue).toContainText('Carte : #103');
          expect(creations).toHaveLength(1);
          expect(creations[0]).toEqual({
            verb: 'board.cards.create',
            request_id: expect.any(String),
            args: {
              project: 42,
              title: titre,
              body: `${ligneSwairm}\n\nTexte de recette.`,
            },
          });
          await dialogue.getByRole('button', { name: 'Fermer', exact: true }).click();
          // Relire avec le vrai cache du daemon, sans modifier son état interne.
          await expect(async () => {
            await mac.goto(`${origine}/board`);
            await expect(node(mac, 'board.carte-103')).toContainText('Swairm', { timeout: 1000 });
            await expect(sansCarte).not.toContainText('owner-a/depot-a#sans');
          }).toPass({ timeout: 20_000, intervals: [1000] });
          expect(creations).toHaveLength(1);
          await node(mac, 'board.carte-103').click();
          for (const refus of [true, false]) {
            refuserNote = refus;
            await mac
              .getByRole('button', { name: 'Écrire une note (à blanc)', exact: true })
              .click();
            const note = mac.getByRole('dialog');
            await note.getByLabel('Texte', { exact: true }).fill('Étape vérifiée.');
            await note.getByRole('button', { name: "Voir l'aperçu" }).click();
            await note.getByRole('button', { name: 'Envoyer', exact: true }).click();
            const numeroNote = mac.locator('strong').filter({ hasText: /^\d{4}$/ });
            await expect(numeroNote).toBeVisible();
            const valeurNote = (await numeroNote.textContent())!;
            expect(notes).toEqual([]);
            await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
            await telephone.getByRole('button', { name: 'Actualiser' }).click();
            await telephone.getByLabel(/^Retape le numéro/).fill(valeurNote);
            await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
            await expect(note.getByRole('status')).toHaveText(
              refus ? 'Le gateway a refusé (statut 403).' : 'Parti.',
              { timeout: 35_000 },
            );
            await expect(note.getByRole('status')).toHaveCount(1);
            await expect(note.getByText('Exécutée', { exact: true })).toHaveCount(0);
            if (refus) expect(notes).toEqual([]);
            await note.getByRole('button', { name: 'Fermer', exact: true }).click();
          }
          expect(notes).toHaveLength(1);
          expect(notes[0]).toMatchObject({
            verb: 'board.cards.say',
            args: { id: 103, content: 'Étape vérifiée.' },
          });
        }
      } finally {
        const nettoyages = await Promise.allSettled([
          fermerContextes(browser),
          arreter(relais),
          fermer(frontalRelais),
          fermer(frontal),
        ]);

        if (home)
          execFileSync(process.execPath, [CLI, 'stop', '--force'], {
            env: { ...process.env, AID_HOME: home },
            timeout: 30_000,
          });
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        rmSync(dossier, { recursive: true, force: true });
        if (home) rmSync(home, { recursive: true, force: true });
        expect(nettoyages.filter((n) => n.status === 'rejected')).toEqual([]);
      }
    },
  );
}
