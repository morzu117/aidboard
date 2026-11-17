import { test } from './fixture.js';
import { explorer } from './explorateur.js';

test('audit complet des interfaces D343', async ({ audit }) => {
  await explorer(audit);
});
