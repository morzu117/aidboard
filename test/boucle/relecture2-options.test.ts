import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClaudeDriver } from '../../src/daemon/conversation/claude.js';
import { CodexDriver } from '../../src/daemon/conversation/codex.js';
import type {
  ConversationDriver,
  ConversationEvent,
} from '../../src/daemon/conversation/driver.js';
import { waitFor } from '../helpers/daemon.js';

let home: string;
let pilote: ConversationDriver | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-relecture-options-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
});

afterEach(async () => {
  try {
    await pilote?.stop();
  } finally {
    pilote = undefined;
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

function options(fixture: string) {
  return {
    bin: join(import.meta.dirname, '../fixtures', fixture),
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH },
    sessionId: randomUUID(),
    resume: false,
  };
}

async function finirTour(driver: ConversationDriver, demande: string) {
  pilote = driver;
  const evenements: ConversationEvent[] = [];
  driver.onEvent((evenement) => evenements.push(evenement));
  driver.start();
  driver.send(demande);
  const fin = await waitFor(
    () => evenements.find((evenement) => evenement.type === 'turn_end'),
    3_000,
    'fin du tour fictif',
  );
  expect(fin.ok).toBe(true);
  return fin;
}

test('Claude manuel avec strict-mcp-config ne transmet pas son texte final', async () => {
  const fin = await finirTour(
    new ClaudeDriver({
      ...options('fake-claude-stream.mjs'),
      extraArgs: ['--strict-mcp-config'],
    }),
    'success avec texte',
  );
  expect(fin).not.toHaveProperty('texteFinal');
});

test('Claude en boucle transmet son texte final sans strict-mcp-config', async () => {
  const fin = await finirTour(
    new ClaudeDriver({ ...options('fake-claude-stream.mjs'), remonterTexteFinal: true }),
    'success avec texte',
  );
  expect(fin.texteFinal).toBe('fait');
});

test('Codex manuel en lecture seule ne transmet pas son texte final', async () => {
  const fin = await finirTour(
    new CodexDriver({ ...options('fake-codex-appserver.mjs'), sandbox: 'read-only' }),
    'réponse fictive',
  );
  expect(fin).not.toHaveProperty('texteFinal');
});

test('Codex en boucle transmet son texte final avec un worktree inscriptible', async () => {
  const fin = await finirTour(
    new CodexDriver({
      ...options('fake-codex-appserver.mjs'),
      sandbox: 'workspace-write',
      remonterTexteFinal: true,
    }),
    'réponse fictive',
  );
  expect(fin.texteFinal).toBe('echo: réponse fictive');
});
