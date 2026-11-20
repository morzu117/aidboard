import Database from 'better-sqlite3';
import { join } from 'node:path';
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
}
