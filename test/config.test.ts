import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_TAILSCALE_BIN,
  loadConfig,
  parseConfig,
  writeDefaultConfigIfAbsent,
} from '../src/daemon/config.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aid-cfg-'));

test('swairm (14.1) : section absente ou vide et binaire vide désactivent la cell', () => {
  expect(DEFAULT_CONFIG.swairm).toEqual({ bin: '' });
  for (const text of ['', '{}', 'swairm: {}', 'swairm:\n  bin: ""\n']) {
    expect(parseConfig(text)).toEqual(DEFAULT_CONFIG);
  }
});

test.each(['swairm', '/tmp/aid-swairm/bin/swairm'])(
  'swairm (14.1) : accepte le binaire %s et conserve les autres défauts',
  (bin) => {
    expect(parseConfig(`swairm:\n  bin: ${bin}\n`)).toEqual({
      ...DEFAULT_CONFIG,
      swairm: { bin },
    });
    expect(parseConfig('').swairm).toEqual({ bin: '' });
  },
);

test.each(['1', 'true', 'null', '[]', '{}'])(
  'swairm (14.1) : refuse un binaire non chaîne (%s)',
  (bin) => {
    expect(() => parseConfig(`swairm:\n  bin: ${bin}\n`)).toThrow(
      'swairm.bin doit être une chaîne',
    );
  },
);

test.each(['1', 'true', 'null', '[]', 'swairm', ''])(
  'swairm (14.1) : refuse une section non objet (%s)',
  (section) => {
    expect(() => parseConfig(`swairm: ${section}\n`)).toThrow('swairm doit être un objet');
  },
);

test('swairm (14.1) : refuse les clés inconnues racine et sous-clés', () => {
  expect(() => parseConfig('swairmm: {}')).toThrow('clé inconnue dans config.yaml : swairmm');
  for (const key of ['boards', 'token']) {
    expect(() => parseConfig(`swairm:\n  ${key}: valeur\n`)).toThrow(
      `clé inconnue dans config.yaml : swairm.${key}`,
    );
  }
});

test('sans fichier, les défauts', () => {
  expect(loadConfig(resolvePaths(tmp()))).toEqual(DEFAULT_CONFIG);
});

test('un fichier partiel est fusionné aux défauts', () => {
  const cfg = parseConfig('port: 5000\nterminal:\n  scrollback: 100\n');
  expect(cfg.port).toBe(5000);
  expect(cfg.terminal).toEqual({ ...DEFAULT_CONFIG.terminal, scrollback: 100 });
  expect(cfg.env.strip).toEqual(DEFAULT_CONFIG.env.strip);
});

test("host 0.0.0.0 est refusé avec un message qui l'explique", () => {
  expect(() => parseConfig('host: 0.0.0.0')).toThrow("A-I-D n'écoute que sur 127.0.0.1");
});

test('une clé inconnue est nommée', () => {
  expect(() => parseConfig('portt: 1')).toThrow('portt');
  expect(() => parseConfig('terminal:\n  scrolback: 1')).toThrow('terminal.scrolback');
});

test('un port invalide est refusé', () => {
  expect(() => parseConfig('port: 70000')).toThrow(ConfigError);
  expect(() => parseConfig('port: "4870"')).toThrow(ConfigError);
});

test('un fichier vide ou fait de commentaires donne les défauts', () => {
  expect(parseConfig('')).toEqual(DEFAULT_CONFIG);
  expect(parseConfig('# rien\n')).toEqual(DEFAULT_CONFIG);
});

test('le fichier par défaut créé est lisible et ne change rien', () => {
  const p = resolvePaths(tmp());
  writeDefaultConfigIfAbsent(p);
  expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  expect(statSync(p.config).mode & 0o777).toBe(0o600);
});

test('memory : les défauts', () => {
  expect(DEFAULT_CONFIG.memory).toEqual({
    embeddings: { provider: 'ollama', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
    maintenance: { enabled: false, model: 'qwen3:8b', window: '02:00-06:00' },
    git: { push: false },
  });
});

test('memory : fusion partielle, le reste vient des défauts', () => {
  const cfg = parseConfig('memory:\n  embeddings:\n    provider: off\n  git:\n    push: true\n');
  expect(cfg.memory.embeddings).toEqual({ ...DEFAULT_CONFIG.memory.embeddings, provider: 'off' });
  expect(cfg.memory.git).toEqual({ push: true });
  expect(cfg.memory.maintenance).toEqual(DEFAULT_CONFIG.memory.maintenance);
});

test('memory : provider, window et clés inconnues sont refusés et nommés', () => {
  expect(() => parseConfig('memory:\n  embeddings:\n    provider: bedrock\n')).toThrow(
    "memory.embeddings.provider vaut 'off' ou 'ollama'",
  );
  expect(() => parseConfig('memory:\n  maintenance:\n    window: "2:00-6:00"\n')).toThrow(
    'memory.maintenance.window',
  );
  expect(() => parseConfig('memory:\n  maintenance:\n    enabled: oui\n')).toThrow(
    'memory.maintenance.enabled',
  );
  expect(() => parseConfig('memory:\n  embeddings:\n    modle: x\n')).toThrow(
    'memory.embeddings.modle',
  );
  expect(() => parseConfig('memory:\n  entretien: true\n')).toThrow('memory.entretien');
});

test('structural : les défauts', () => {
  expect(DEFAULT_CONFIG.structural).toEqual({
    engine: 'codegraph',
    bin: 'codegraph',
    timeoutMs: 60_000,
    exclude: [],
  });
});

test('structural : fusion partielle, le reste vient des défauts', () => {
  const cfg = parseConfig('structural:\n  engine: off\n');
  expect(cfg.structural).toEqual({ ...DEFAULT_CONFIG.structural, engine: 'off' });
});

test('structural : moteur inconnu, clé inconnue et champs invalides sont refusés et nommés', () => {
  expect(() => parseConfig('structural:\n  engine: kivgraph\n')).toThrow(
    'moteur inconnu (disponibles : codegraph, off)',
  );
  expect(() => parseConfig('structural:\n  foo: 1\n')).toThrow('structural.foo');
  expect(() => parseConfig('structural:\n  bin: 1\n')).toThrow('structural.bin');
  expect(() => parseConfig('structural:\n  timeoutMs: -1\n')).toThrow('structural.timeoutMs');
  expect(() => parseConfig('structural:\n  exclude: [1]\n')).toThrow('structural.exclude');
});

test('ensureHome pose 0700, y compris sur un dossier déjà en 0755', () => {
  const home = tmp();
  mkdirSync(join(home, 'logs'), { mode: 0o755 });
  writeFileSync(join(home, 'x'), '');
  const p = resolvePaths(home);
  ensureHome(p);
  for (const d of [p.home, p.logs, p.actionLogs, p.worktrees, p.spool]) {
    expect(statSync(d).mode & 0o777).toBe(0o700);
  }
});

test('mesh (12.2) : les défauts — désactivé, Tailscale lu mais jamais piloté', () => {
  expect(DEFAULT_CONFIG.mesh).toEqual({
    bin: 'swarph',
    cell: '',
    cellFile: '',
    gateway: '',
    stateRoot: '',
    tailscale: { manage: false, bin: DEFAULT_TAILSCALE_BIN },
  });
  expect(DEFAULT_TAILSCALE_BIN).toBe(
    process.platform === 'darwin'
      ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
      : 'tailscale',
  );
});

test('mesh (12.2) : fusion partielle, le reste vient des défauts', () => {
  const cfg = parseConfig(
    'mesh:\n  cell: morzu-mac\n  gateway: http://mesh-gw.example.ts.net:8788\n  tailscale:\n    manage: true\n',
  );
  expect(cfg.mesh).toEqual({
    ...DEFAULT_CONFIG.mesh,
    cell: 'morzu-mac',
    gateway: 'http://mesh-gw.example.ts.net:8788',
    tailscale: { manage: true, bin: DEFAULT_TAILSCALE_BIN },
  });
});

test('agents (15, D63/A.6) : défaut stream, repli vers pty accepté', () => {
  expect(DEFAULT_CONFIG.agents).toEqual({ transport: 'stream' });
  expect(parseConfig('agents:\n  transport: pty\n').agents).toEqual({ transport: 'pty' });
});

test('agents (15, D63) : valeur et clé inconnues refusées et nommées', () => {
  expect(() => parseConfig('agents:\n  transport: headless\n')).toThrow(
    "agents.transport vaut 'pty' ou 'stream'",
  );
  expect(() => parseConfig('agents:\n  pilote: claude\n')).toThrow('agents.pilote');
  expect(() => parseConfig('agents: []\n')).toThrow('agents doit être un objet');
});

test('mesh (12.2) : clé inconnue et champs invalides sont refusés et nommés', () => {
  expect(() => parseConfig('mesh:\n  token: abc\n')).toThrow('mesh.token');
  expect(() => parseConfig('mesh:\n  cell: 1\n')).toThrow('mesh.cell');
  expect(() => parseConfig('mesh:\n  cell: "a b"\n')).toThrow('mesh.cell');
  expect(() => parseConfig('mesh:\n  gateway: mesh-gw:8788\n')).toThrow('mesh.gateway');
  expect(() => parseConfig('mesh:\n  bin: ""\n')).toThrow('mesh.bin');
  expect(() => parseConfig('mesh:\n  tailscale: 1\n')).toThrow('mesh.tailscale');
  expect(() => parseConfig('mesh:\n  tailscale:\n    up: true\n')).toThrow('mesh.tailscale.up');
  expect(() => parseConfig('mesh:\n  tailscale:\n    manage: oui\n')).toThrow(
    'mesh.tailscale.manage',
  );
  expect(() => parseConfig('mesh: []\n')).toThrow('mesh doit être un objet');
});
