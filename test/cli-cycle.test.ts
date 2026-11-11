import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
let serveur: Server;
let home: string;
const enfants: ChildProcess[] = [];
afterEach(async () => {
  for (const enfant of enfants.splice(0)) enfant.kill('SIGKILL');
  serveur?.closeAllConnections();
  await new Promise<void>((resolve) => (serveur ? serveur.close(() => resolve()) : resolve()));
  if (home) rmSync(home, { recursive: true, force: true });
});

for (const etat of [true, false, null, 'erreur'] as const) {
  for (const accord of [true, false]) {
    test.skipIf(!existsSync(cli))(`CLI cycle : watcher=${etat}, accord=${accord}`, async () => {
      home = mkdtempSync(join(tmpdir(), 'aid-cycle-'));
      const lancer = () => {
        const enfant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        enfants.push(enfant);
        return enfant;
      };
      const ancien = lancer();
      let cycles = 0;
      let consultations = 0;
      serveur = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/daemon/update') {
          consultations++;
          res.statusCode = etat === 'erreur' ? 500 : 200;
          res.end(JSON.stringify({ available: etat === true }));
        } else if (req.url === '/api/daemon/cycle') {
          cycles++;
          res.statusCode = 202;
          res.end('{"cycling":true}');
          ancien.kill('SIGKILL');
          ecrire(lancer().pid!);
        } else res.end('{}');
      });
      await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
      const port = (serveur.address() as { port: number }).port;
      const ecrire = (pid: number) =>
        writeFileSync(
          join(home, 'daemon.json'),
          JSON.stringify({
            pid,
            port,
            token: 'exemple',
            startedAt: new Date().toISOString(),
          }),
        );
      ecrire(ancien.pid!);
      const resultat = await new Promise<{ code: number; sortie: string }>((resolve) => {
        execFile(
          process.execPath,
          [cli, '--cycle', ...(accord ? ['--force'] : [])],
          {
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([k]) => !k.startsWith('AID_')),
              ),
              AID_HOME: home,
              AID_NO_BROWSER: '1',
            },
            timeout: 12000,
          },
          (err, stdout) => resolve({ code: err ? Number(err.code) : 0, sortie: stdout }),
        );
      });
      expect(resultat.code).toBe(etat === true && !accord ? 3 : 0);
      expect(resultat.sortie).toContain(`http://127.0.0.1:${port}/?token=exemple`);
      expect(consultations).toBe(1);
      expect(cycles).toBe(etat === true && accord ? 1 : 0);
      const actuel = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number };
      expect(actuel.pid === ancien.pid).toBe(cycles === 0);
      expect(existsSync(join(home, 'reprise.json'))).toBe(false);
    });
  }
}

test.skipIf(!existsSync(cli))(
  'CLI cycle : pid vivant mais HTTP muet, échec borné',
  async () => {
    home = mkdtempSync(join(tmpdir(), 'aid-cycle-muet-'));
    const enfant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    enfants.push(enfant);
    serveur = createServer(() => {});
    await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
    const port = (serveur.address() as { port: number }).port;
    writeFileSync(join(home, 'config.yaml'), `port: ${port}\n`);
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({
        pid: enfant.pid,
        port,
        token: 'exemple',
        startedAt: new Date().toISOString(),
      }),
    );
    const debut = Date.now();
    const code = await new Promise<number>((resolve) => {
      execFile(
        process.execPath,
        [cli, '--cycle'],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([k]) => !k.startsWith('AID_')),
            ),
            AID_HOME: home,
            AID_NO_BROWSER: '1',
          },
          timeout: 32000,
        },
        (err) => resolve(err ? Number(err.code) : 0),
      );
    });
    expect(code).toBe(1);
    expect(Date.now() - debut).toBeLessThan(32000);
  },
  35000,
);
