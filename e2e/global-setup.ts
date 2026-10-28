import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// AID_E2E_PORT : quand 4871 est pris sur le poste (l'app de bureau AID.app l'écoute, constaté le 2026-10-20)
const PORT = Number(process.env.AID_E2E_PORT ?? 4871);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

// Un daemon neuf par exécution : AID_HOME temporaire, port 4871, shell /bin/sh pour des terminaux sobres.
// Le faux « claude » des fixtures passe devant le PATH : jamais le vrai agent dans un test.
export default async function globalSetup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-')));
  // 12.7 : le mesh swarph sur les faux binaires (D40) — jamais le vrai swarph ni Tailscale, aucun réseau
  const fixtures = join(import.meta.dirname, '../test/fixtures');
  const mesh = [
    'mesh:',
    `  bin: ${join(fixtures, 'fake-swarph.sh')}`,
    '  cell: morzu-mac',
    `  cellFile: ${join(home, 'morzu-mac.yaml')}`,
    '  gateway: http://mesh-gw.example:8788',
    `  stateRoot: ${join(home, 'swarph_state')}`,
    '  tailscale:',
    '    manage: false',
    `    bin: ${join(fixtures, 'fake-tailscale.sh')}`,
  ].join('\n');
  // 14.6 : la cell Swairm sur le faux CLI (D48) — chemin absolu, jamais le vrai swairm ni le ~/.aid réel
  const swairm = ['swairm:', `  bin: ${join(fixtures, 'fake-swairm.sh')}`].join('\n');
  // D63/A.6 : le défaut est passé à `stream`, mais les fixtures e2e jouent le faux claude PTY — jamais structuré.
  const agents = ['agents:', '  transport: pty'].join('\n');
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\n${mesh}\n${swairm}\n${agents}\n`, {
    mode: 0o600,
  });
  const PATH = `${join(import.meta.dirname, '../test/fixtures/bin')}${delimiter}${process.env.PATH}`;
  const env = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH,
    FAKE_SWARPH_LOG: join(home, 'swarph.log'),
    FAKE_TAILSCALE_STATEFILE: join(home, 'tailscale.state'),
    FAKE_TAILSCALE_LOG: join(home, 'tailscale.log'),
    FAKE_SWAIRM_LOG: join(home, 'swairm.log'),
    FAKE_SWAIRM_INPUT_LOG: join(home, 'swairm-input.log'),
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
    token: string;
    pid: number;
  };
  process.env.AID_E2E_HOME = home;
  process.env.AID_E2E_URL = `http://127.0.0.1:${PORT}`;
  process.env.AID_E2E_TOKEN = info.token;
  process.env.AID_E2E_PID = String(info.pid);
}
