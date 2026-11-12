import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';

interface MeshFaux {
  nom: string;
  home: string;
  requetes: Array<{ verb: string; args: Record<string, unknown> }>;
  config: string;
  fermer(): Promise<void>;
}

/** Deux transports locaux indépendants ; les réglages du faux CLI restent hors de l'environnement produit. */
export async function preparerMeshes(noms = ['principal', 'perso']) {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-46-meshes-'));
  const fixtures = join(import.meta.dirname, '../test/fixtures');
  const bin = join(dossier, 'swarph');
  writeFileSync(
    bin,
    `#!/bin/sh\nexport FAKE_SWARPH_LOG="$HOME/swarph.log"\nexec '${join(fixtures, 'fake-swarph.sh')}' "$@"\n`,
    { mode: 0o700 },
  );
  const meshes: MeshFaux[] = [];
  for (const nom of noms) {
    const home = join(dossier, nom);
    const inboxLog = join(home, 'inbox.log');
    mkdirSync(home);
    writeFileSync(
      inboxLog,
      JSON.stringify({
        id: 46,
        thread_id: null,
        from_node: 'peer-b',
        to_node: 'peer-a',
        kind: 'question',
        content: 'Même id, deux messages.',
        created_at: '2026-11-12T10:00:00Z',
        read_at: null,
        priority: 'normal',
      }) + '\n',
    );
    const socket = join(home, 'proxy.sock');
    const requetes: Array<{ verb: string; args: Record<string, unknown> }> = [];
    const connexions = new Set<Socket>();
    const serveur = createServer((connexion) => {
      connexions.add(connexion);
      connexion.on('error', () => undefined);
      connexion.on('close', () => connexions.delete(connexion));
      let tampon = '';
      connexion.on('data', (morceau) => {
        tampon += morceau.toString();
        if (!tampon.includes('\n')) return;
        const requete = JSON.parse(tampon.split('\n')[0]!) as {
          request_id: string;
          verb: string;
          args: Record<string, unknown>;
        };
        requetes.push(requete);
        let body: unknown = {};
        if (requete.verb === 'board.projects.list') {
          body = JSON.parse(readFileSync(join(fixtures, 'board/projects-list.json'), 'utf8'));
        } else if (requete.verb === 'board.cards.list') {
          const cartes = JSON.parse(
            readFileSync(join(fixtures, 'board/cards-list-42.json'), 'utf8'),
          ) as { cards: Array<{ title: string }> };
          for (const carte of cartes.cards) carte.title = `Carte ${nom}`;
          body = cartes;
        } else if (requete.verb === 'mesh.peers') {
          body = { peers: [{ name: 'peer-a' }, { name: 'peer-b' }] };
        } else if (requete.verb === 'mesh.send') {
          body = { id: 47, open_obligations: [], closed_obligations: [] };
        }
        connexion.end(
          JSON.stringify({ request_id: requete.request_id, ok: true, status: 200, body }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      serveur.once('error', reject);
      serveur.listen(socket, resolve);
    });
    meshes.push({
      nom,
      home,
      requetes,
      config: `  ${nom}:\n    cell: peer-a\n    home: ${home}\n    gateway: https://${nom === 'principal' ? 'aid-e2e.ts.net' : 'example.com'}\n    proxySocket: ${socket}\n    inboxLog: ${inboxLog}`,
      async fermer() {
        for (const connexion of connexions) connexion.destroy();
        await new Promise<void>((resolve, reject) =>
          serveur.close((erreur) => (erreur ? reject(erreur) : resolve())),
        );
      },
    });
  }
  return {
    dossier,
    supplement: `  bin: ${bin}\nmeshes:\n${meshes.map((m) => m.config).join('\n')}`,
    meshes,
    async fermer() {
      await Promise.all(meshes.map((m) => m.fermer()));
    },
  };
}
