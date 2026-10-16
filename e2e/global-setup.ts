import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const PORT = 4871;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

// Un daemon neuf par exécution : AID_HOME temporaire, port 4871, shell /bin/sh pour des terminaux sobres.
// Le faux « claude » des fixtures passe devant le PATH : jamais le vrai agent dans un test.
export default async function globalSetup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\n`, { mode: 0o600 });
  const PATH = `${join(import.meta.dirname, '../test/fixtures/bin')}${delimiter}${process.env.PATH}`;
  const env = { ...process.env, AID_HOME: home, AID_NO_BROWSER: '1', SHELL: '/bin/sh', PATH };
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
