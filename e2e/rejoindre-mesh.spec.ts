import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const fixtures = join(import.meta.dirname, '../test/fixtures');
const fauxJeton = 'FAUX-JETON-NE-JAMAIS-SERVIR';

for (const issue of ['approuve', 'refuse', 'expire', 'annule', 'oublier']) {
  test(`Machines : rejoindre un mesh — ${issue}`, async ({ browser }) => {
    const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-rejoindre-')));
    const port = Number(process.env.AID_E2E_PORT ?? 4871) + 1;
    const origine = `http://127.0.0.1:${port}`;
    const scenario = join(dossier, 'scenario.json');
    const config = join(dossier, 'config.yaml');
    const jeton = join(dossier, '.config', 'swarph', 'peer-b.peer_token');
    const piloter = (suite: Record<string, unknown>) =>
      writeFileSync(scenario, JSON.stringify({ cell: 'peer-b', pilotage: true, ...suite }));
    cpSync(join(fixtures, 'fake-swarph-join.mjs'), join(dossier, 'join.mjs'));
    piloter({ attente: true, temoin: true });
    if (issue === 'oublier') {
      mkdirSync(join(dossier, '.config', 'swarph'), { recursive: true });
      writeFileSync(jeton, fauxJeton, { mode: 0o600 });
    }
    const swarph = join(dossier, 'swarph');
    // Seuls --version et join passent au faux d'inscription ; les lectures restent locales.
    writeFileSync(
      swarph,
      `#!/bin/sh\ncase "$1" in\n--version|join) exec '${process.execPath}' '${join(dossier, 'join.mjs')}' "$@" ;;\n*) exec '${join(fixtures, 'fake-swarph.sh')}' "$@" ;;\nesac\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      config,
      `port: ${port}\nmesh:\n  bin: ${swarph}\n${issue === 'oublier' ? '' : `  home: ${dossier}\n  cell: peer-a\n  gateway: https://example.com\n`}  tailscale:\n    manage: false\n    bin: ${join(fixtures, 'fake-tailscale.sh')}\n${issue === 'oublier' ? `meshes:\n  principal:\n    home: ${dossier}\n    cell: peer-a\n    gateway: https://example.com\n  perso:\n    cell: peer-b\n    gateway: https://aid-e2e.ts.net\n    home: ${dossier}\n` : ''}`,
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      AID_HOME: dossier,
      AID_NO_BROWSER: '1',
      SHELL: '/bin/sh',
      PATH: `${join(fixtures, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_TAILSCALE_STATEFILE: join(dossier, 'tailscale.state'),
    };
    const contexte = await browser.newContext();
    const lectures: Promise<string>[] = [];
    let demarre = false;
    try {
      execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
      demarre = true;
      const { token } = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8'));
      const page = await contexte.newPage();
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origine ? route.continue() : route.abort(),
      );
      await page.goto(`${origine}/?token=${token}`);
      await page.goto(`${origine}/machines`);
      const section = page.getByRole('region', { name: 'Meshes', exact: true });
      await expect(section).toBeVisible();
      page.on('response', (reponse) => {
        if (
          reponse.url().startsWith(origine) &&
          reponse.headers()['content-type']?.includes('json')
        )
          lectures.push(reponse.text());
      });

      const lireConfig = () => parse(readFileSync(config, 'utf8'));
      const avant = readFileSync(config, 'utf8');
      if (issue === 'oublier') {
        const ligne = section.getByRole('listitem').filter({ hasText: 'perso · peer-b' });
        await ligne.getByRole('button', { name: 'Oublier', exact: true }).click();
        await expect(section.getByRole('status')).toContainText('Le jeton existe toujours.');
        expect(lireConfig().meshes.perso).toBeUndefined();
        expect(lireConfig().meshes.principal.cell).toBe('peer-a');
        expect(readFileSync(jeton, 'utf8')).toBe(fauxJeton);
      } else {
        await section.getByRole('button', { name: 'Rejoindre un mesh', exact: true }).click();
        await section
          .getByLabel('Adresse du gateway')
          .fill(issue === 'approuve' ? 'https://aid-e2e.ts.net/' : 'https://aid-e2e.ts.net');
        await section.getByLabel('Nom de la nouvelle cell').fill('peer-b');
        await section.getByLabel('Nom local du mesh').fill('perso');
        await section.getByRole('button', { name: 'Rejoindre', exact: true }).click();
        await expect(section.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
        const compteur = section.getByText(/^Expiration dans \d+:\d{2}$/);
        await expect(compteur).toBeVisible();
        const debut = await compteur.textContent();
        await expect(compteur).not.toHaveText(debut!);
        if (issue === 'annule') {
          await section.getByRole('button', { name: 'Annuler', exact: true }).click();
          await expect(section).toContainText(
            "Demande annulée : demande à l'opérateur de refuser le code ABCD-EFGH",
          );
          await expect(section.locator('pre')).toHaveText(
            "swarph mesh approve 'ABCD-EFGH' --gateway 'https://aid-e2e.ts.net' --refuse --token-file <JETON-OPÉRATEUR>",
          );
          await expect(
            section.getByRole('button', { name: 'Copier la commande de refus' }),
          ).toBeVisible();
          expect(readFileSync(join(dossier, 'signal'), 'utf8')).toBe('SIGINT');
        } else {
          piloter({
            attente: false,
            temoin: true,
            ...(issue === 'refuse'
              ? { raison: 'access_denied' }
              : issue === 'expire'
                ? { raison: 'expired_token' }
                : {}),
          });
          if (issue === 'approuve') {
            await expect(section).toContainText('Cell inscrite, pas encore ratifiée');
            for (const question of [
              'How will you handle routine AI-to-AI peer DMs, and stop at privilege boundaries?',
              'How will you keep your canonical name and flag a DM addressed to the wrong identity?',
              'How will you disclose mistakes and assumptions to the peers affected?',
              'What counts as a mesh secret, and how will you keep it out of mesh messages?',
            ])
              await expect(
                section.getByRole('listitem').filter({ hasText: question }),
              ).toBeVisible();
            await expect(section).toContainText('Redémarre le daemon');
            expect(lireConfig().meshes.perso).toMatchObject({
              cell: 'peer-b',
              gateway: 'https://aid-e2e.ts.net',
            });
            expect(statSync(jeton).mode & 0o777).toBe(0o600);
            expect(readFileSync(jeton, 'utf8')).toBe(fauxJeton);
          } else {
            await expect(section).toContainText(
              issue === 'refuse'
                ? 'Demande refusée par l’opérateur du gateway.'
                : 'La demande a expiré.',
            );
          }
        }
        if (issue !== 'approuve') expect(readFileSync(config, 'utf8')).toBe(avant);
      }
      expect(await page.locator('body').textContent()).not.toContain(fauxJeton);
      expect((await Promise.all(lectures)).join('\n')).not.toContain(fauxJeton);
      await contexte.close();
      execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
      demarre = false;
      expect(readFileSync(join(dossier, 'daemon.log'), 'utf8')).not.toContain(fauxJeton);
      for (const fichier of readdirSync(join(dossier, 'logs'), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (fichier.isFile())
          expect(readFileSync(join(fichier.parentPath, fichier.name), 'utf8')).not.toContain(
            fauxJeton,
          );
      }
    } catch (erreur) {
      if (existsSync(join(dossier, 'daemon.log')))
        console.error(readFileSync(join(dossier, 'daemon.log'), 'utf8'));
      throw erreur;
    } finally {
      await contexte.close();
      if (demarre)
        execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
      rmSync(dossier, { recursive: true, force: true });
    }
  });
}
