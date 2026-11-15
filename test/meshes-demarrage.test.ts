import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import * as execution from '../src/daemon/mesh/exec.js';
import { startTestDaemon } from './helpers/daemon.js';

test('le daemon écoute en moins de 15 s sans réponse du monitor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-demarrage-'));
  let liberer!: (resultat: execution.MeshExecResult) => void;
  const monitor = new Promise<execution.MeshExecResult>((resolve) => {
    liberer = resolve;
  });
  let monitorAppele = false;
  const exec = vi.spyOn(execution, 'meshExec').mockImplementation(async (_bin, args) => {
    if (args[0] === 'monitor') {
      monitorAppele = true;
      return monitor;
    }
    return { ok: true, stdout: '{}', stderr: '', timedOut: false };
  });
  const debut = performance.now();
  let instance: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  try {
    instance = await startTestDaemon(home, {
      config: {
        mesh: { ...DEFAULT_CONFIG.mesh, bin: process.execPath },
        meshes: {
          principal: {
            ...DEFAULT_CONFIG.mesh,
            cell: 'peer-a',
            home,
            gateway: 'https://example.com',
          },
        },
      },
    });
    const reponse = await fetch(`http://127.0.0.1:${instance.d.port}/api/meshes`, {
      headers: instance.headers,
    });
    expect(reponse.status).toBe(200);
    expect(performance.now() - debut).toBeLessThan(15_000);
    expect(monitorAppele).toBe(true);
    expect(await reponse.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ nom: 'principal', actif: true })]),
    );
  } finally {
    liberer({ ok: false, stdout: '', stderr: '', timedOut: true });
    await instance?.d.stop();
    exec.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
