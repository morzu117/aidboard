import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const fichierClics = () => join(tmpdir(), 'aid-couverture-ui.jsonl');
export const fichierVisuel = () => join(tmpdir(), 'aid-visuel-ui.jsonl');
