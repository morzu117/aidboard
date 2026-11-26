import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { makeOriginAndClone } from '../test/helpers/git.js';
import type { EtatBoucle } from '../src/daemon/boucle/etat.js';
import { capturerBoutons } from './captures-boutons.js';
import { createTopic, registerWorkspace, state } from './helpers.js';
import { expect, type Page, test } from './test.js';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const faux = join(import.meta.dirname, '../test/fixtures/faux-agent-boucle.mjs');
const port = Number(
  process.env.AID_E2E_BOUCLE_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 12,
);

async function commande(
  page: Page,
  url: string,
  corps: Record<string, string> = {},
  methode = 'POST',
) {
  return page.evaluate(
    async ({ url, corps, methode }) =>
      (
        await fetch(url, {
          method: methode,
          headers: { 'content-type': 'application/json', 'x-aid-cockpit': '1' },
          body: JSON.stringify(corps),
        })
      ).status,
    { url, corps, methode },
  );
}

test('vue Boucle : chaque commande est active, affiche le refus du daemon, puis réussit', async ({
  browser,
}) => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-boucle-')));
  const env = {
    ...process.env,
    AID_HOME: dossier,
    HOME: dossier,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${dossier}${delimiter}${process.env.PATH ?? ''}`,
  };
  const contexte = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await contexte.newPage();
  let demarre = false;

  try {
    writeFileSync(
      join(dossier, 'config.yaml'),
      `port: ${port}\nagents:\n  transport: stream\nmemory:\n  embeddings:\n    provider: off\nstructural:\n  engine: off\n`,
    );
    for (const nom of ['claude', 'codex']) {
      writeFileSync(
        join(dossier, nom),
        `#!/bin/sh\nexec "${process.execPath}" "${faux}" "${dossier}" "$@"\n`,
        { mode: 0o700 },
      );
    }
    execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
    demarre = true;
    const info = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8')) as {
      token: string;
    };
    await page.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(info.token)}`);

    const { clone: depot } = makeOriginAndClone(dossier, { name: 'depot-boucle-fictif' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: depot });
    writeFileSync(
      join(depot, 'agent.yml'),
      'project: { namespace: aid }\nphases: [plan, dev, review]\ncapabilities: { dev_agent: claude, review_agent: claude }\ngates: { gate: "exit 0" }\n',
    );
    git('add', 'agent.yml');
    git(
      '-c',
      'user.name=Auteur fictif',
      '-c',
      'user.email=auteur@example.com',
      'commit',
      '-qm',
      'Manifeste',
    );
    git('push', '-q', 'origin', 'HEAD');

    await registerWorkspace(page, depot);
    const sujetId = await createTopic(page, 'Sujet boucle fictif');
    const sujet = (await state(page)).topics.find(({ id }) => id === sujetId);
    if (!sujet || !('slug' in sujet) || typeof sujet.slug !== 'string') {
      throw new Error('Slug du sujet fictif absent');
    }
    const url = `/api/topics/${sujetId}/boucle`;
    const bouton = (id: string, libelle: string) =>
      page
        .getByRole('button', { name: libelle, exact: true })
        .and(page.getByTestId(`boucle-${id}`));
    const phase = page.getByTestId('boucle-phase');
    const verifierPhase = async (valeur: EtatBoucle['phase'], libelle: string) => {
      await expect(phase).toHaveText(libelle);
      const resultat = await page.request.get(new URL(url, page.url()).href, {
        headers: { 'x-aid-cockpit': '1' },
      });
      expect(resultat.ok()).toBe(true);
      expect(await resultat.json()).toMatchObject({ phase: valeur });
    };

    async function refuserPuisCliquer(id: string, libelle: string, suffixe: string) {
      const cible = bouton(id, libelle);
      await expect(cible).toHaveAttribute('data-node', `boucle-${id}`);
      await expect(cible).toBeEnabled();
      expect(await commande(page, '/api/confirmations/armer')).toBe(200);
      const refus = page.waitForResponse(
        (r) => new URL(r.url()).pathname === url + suffixe && r.request().method() === 'POST',
      );
      await cible.click();
      expect((await refus).status()).toBe(409);
      await expect(page.getByText(/confirmation_impossible|Allume le PDA/)).toBeVisible();
      expect(await commande(page, '/api/confirmations/desarmer', { phrase: 'DÉSARMER' })).toBe(200);
      await expect(cible).toBeEnabled();
      await cible.click();
    }

    const onglet = bouton('ouvrir', 'Boucle');
    await expect(onglet).toHaveAttribute('data-node', 'boucle-ouvrir');
    await onglet.click();
    await capturerBoutons(page, 'boucle-vide', bouton('lancer', 'Lancer'));
    await refuserPuisCliquer('lancer', 'Lancer', '');
    await verifierPhase('plan', 'Plan');
    expect(await commande(page, url)).toBe(409);

    expect([200, 201]).toContain(
      await commande(
        page,
        `/api/memory/pages/aid/plan/${sujet.slug}`,
        {
          text: '## Point exemple\nPréparer une note.',
        },
        'PUT',
      ),
    );
    writeFileSync(join(dossier, 'plan-ecrit'), '');
    await verifierPhase('attente_go', 'En attente du GO');
    await capturerBoutons(page, 'boucle-attente-go', bouton('go', 'GO'));
    await refuserPuisCliquer('go', 'GO', '/go');
    await verifierPhase('escalade', 'Escalade');
    expect(await commande(page, `${url}/go`)).toBe(409);

    const reponse = page.getByLabel('Réponse').and(page.getByTestId('boucle-reponse'));
    await expect(reponse).toHaveAttribute('data-node', 'boucle-reponse');
    const envoyer = bouton('envoyer-reponse', 'Envoyer la réponse');
    await expect(envoyer).toBeDisabled();
    await reponse.click();
    await reponse.fill('Texte');
    await expect(page.getByText('Quel format ?')).toBeVisible();
    await capturerBoutons(page, 'boucle-escalade', envoyer);
    await refuserPuisCliquer('envoyer-reponse', 'Envoyer la réponse', '/reponse');
    await verifierPhase('dev', 'Dev');
    await expect.poll(() => existsSync(join(dossier, 'reponse-recue'))).toBe(true);
    await capturerBoutons(page, 'boucle-dev', bouton('arreter', 'Arrêter'));

    const pid = Number(readFileSync(join(dossier, 'dev-pid'), 'utf8'));
    await refuserPuisCliquer('arreter', 'Arrêter', '/arreter');
    await verifierPhase('arretee', 'Arrêtée');
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (erreur) {
          if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
          return false;
        }
      })
      .toBe(false);
    await capturerBoutons(page, 'boucle-arretee', phase);
  } finally {
    try {
      await contexte.close();
      if (demarre)
        execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  }
});
