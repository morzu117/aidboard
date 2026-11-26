import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { RetroPayload } from '../src/daemon/memory/retro.js';
import { EN_TETE_COCKPIT } from '../src/shared/cockpit.js';
import type { MemoryProposal } from '../src/shared/memory.js';
import { openApp } from './helpers.js';
import { expect, test } from './test.js';
import { detecterVisuel } from './visuel.js';

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`décider les propositions de leçon dans la Boîte (${viewport.width} px)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport });
    const page = await openApp(context);
    const origine = new URL(page.url()).origin;
    const headers = { [EN_TETE_COCKPIT]: '1', origin: origine };
    const base = `lesson/recette/format-${viewport.width}`;
    const tags = `${base}-tags`;
    const doublon = `${base}-doublon`;
    const ids = [`e2e-tags-${viewport.width}`, `e2e-doublon-${viewport.width}`];
    const db = new Database(join(process.env.AID_E2E_HOME!, 'state.db'), { timeout: 5000 });
    try {
      for (const slug of [tags, doublon]) {
        const r = await page.request.put(`${origine}/api/memory/pages/${slug}`, {
          headers,
          data: { text: 'Un corps de leçon de recette.' },
        });
        expect(r.ok()).toBe(true);
      }
      const insert = db.prepare(
        "INSERT INTO memory_proposals (id, kind, slug, payload, rationale, state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
      );
      const date = new Date().toISOString();
      insert.run(ids[0], 'tags', tags, JSON.stringify({ tags: ['recette'] }), 'Tag proposé', date);
      insert.run(
        ids[1],
        'duplicate',
        doublon,
        JSON.stringify({ duplicateOf: tags }),
        'Page similaire',
        date,
      );
      await page.goto(`${origine}/boite`);
      const section = page.getByRole('region', { name: 'Entretien de la mémoire' });
      await expect(section).toBeVisible();
      expect(await detecterVisuel(page)).toEqual([]);
      const articles = section.getByRole('article');
      await articles
        .filter({ hasText: 'Tag proposé' })
        .getByRole('button', { name: 'Appliquer' })
        .click();
      await expect(articles.filter({ hasText: 'Tag proposé' })).toHaveCount(0);
      await articles
        .filter({ hasText: 'Page similaire' })
        .getByRole('button', { name: 'Rejeter' })
        .click();
      await expect(section).toHaveCount(0);
      for (const [i, state] of ['applied', 'rejected'].entries()) {
        const response = await page.request.get(`${origine}/api/memory/proposals?state=${state}`, {
          headers,
        });
        const { proposals } = (await response.json()) as { proposals: MemoryProposal[] };
        expect(proposals.some((p) => p.id === ids[i])).toBe(true);
      }
    } finally {
      db.prepare('DELETE FROM memory_proposals WHERE id IN (?, ?)').run(...ids);
      db.close();
      await context.close();
    }
  });

  test(`décider les rétros et leurs leçons dans la Boîte (${viewport.width} px)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport });
    const page = await openApp(context);
    const origine = new URL(page.url()).origin;
    const headers = { [EN_TETE_COCKPIT]: '1', origin: origine };
    const cycles = [`appliquer-${viewport.width}`, `rejeter-${viewport.width}`];
    const propositions = cycles.map((cycle) => {
      const payload: RetroPayload = {
        topicId: cycle,
        retro: {
          slug: `exemple/retro/${cycle}`,
          text: '---\ntitle: Rétro proposée\n---\n\n<b>Bilan du cycle.</b>',
        },
        lecons: ['a', 'b', 'c'].map((suffixe) => ({
          slug: `lesson/recette/${cycle}-${suffixe}`,
          text: `---\ntitle: Leçon ${suffixe}\n---\n\n<em>Texte de la leçon ${suffixe}.</em>`,
        })),
        sources: { pages: [`exemple/plan/${cycle}`], actions: 2, reprises: 3 },
      };
      return { id: `e2e-retro-${cycle}`, cycle, payload };
    });
    const db = new Database(join(process.env.AID_E2E_HOME!, 'state.db'), { timeout: 5000 });
    try {
      const insert = db.prepare(
        "INSERT INTO memory_proposals (id, kind, slug, payload, rationale, state, created_at) VALUES (?, 'retro', ?, ?, ?, 'open', ?)",
      );
      for (const { id, payload } of propositions) {
        insert.run(
          id,
          payload.retro.slug,
          JSON.stringify(payload),
          'Cycle terminé',
          new Date().toISOString(),
        );
      }
      await page.goto(`${origine}/boite`);
      const section = page.getByRole('region', { name: 'Entretien de la mémoire' });
      const [appliquee, rejetee] = propositions;
      const carte = section
        .getByRole('article')
        .filter({ hasText: `Rétro de ${appliquee!.cycle}` });
      await expect(carte.getByText('lu : 1 pages, 2 actions, 3 reprises')).toBeVisible();
      await expect(carte.getByText('<b>Bilan du cycle.</b>')).toBeVisible();
      await expect(carte.getByText('title: Rétro proposée')).toHaveCount(0);
      const cases = carte.getByRole('checkbox');
      await expect(cases).toHaveCount(3);
      for (const caseLecon of await cases.all()) await expect(caseLecon).toBeChecked();
      await carte.getByText('Voir le texte', { exact: true }).nth(1).click();
      await expect(carte.getByText('<em>Texte de la leçon b.</em>')).toBeVisible();
      await cases.nth(1).uncheck();
      await carte.getByRole('button', { name: 'Appliquer' }).click();
      await expect(carte).toHaveCount(0);
      await section
        .getByRole('article')
        .filter({ hasText: `Rétro de ${rejetee!.cycle}` })
        .getByRole('button', { name: 'Rejeter' })
        .click();
      await expect(section).toHaveCount(0);

      const statut = async (slug: string) =>
        (await page.request.get(`${origine}/api/memory/pages/${slug}`, { headers })).status();
      expect(await statut(appliquee!.payload.retro.slug)).toBe(200);
      for (const [index, { slug }] of appliquee!.payload.lecons.entries()) {
        expect(await statut(slug)).toBe(index === 1 ? 404 : 200);
      }
      for (const { slug } of [rejetee!.payload.retro, ...rejetee!.payload.lecons]) {
        expect(await statut(slug)).toBe(404);
      }
    } finally {
      db.prepare('DELETE FROM memory_proposals WHERE id IN (?, ?)').run(
        ...propositions.map(({ id }) => id),
      );
      db.close();
      await context.close();
    }
  });
}
