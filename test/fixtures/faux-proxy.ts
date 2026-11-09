import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScenarioProxy =
  | { reponse: Record<string, unknown> }
  | 'request_id_faux'
  | 'illisible'
  | 'silence'
  | 'fermeture'
  | 'fermeture_apres_ligne'
  | 'trop_longue'
  | 'fragmentee'
  | 'deux_lignes';

export async function creerFauxProxy(scenario: ScenarioProxy) {
  const dossier = await mkdtemp(join(tmpdir(), 'aid-proxy-'));
  const socket = join(dossier, 'proxy.sock');
  const lignes: string[] = [];
  const connexions = new Set<Socket>();
  let nombreConnexions = 0;
  const serveur = createServer((connexion) => {
    nombreConnexions++;
    connexions.add(connexion);
    connexion.on('error', () => undefined);
    connexion.on('close', () => connexions.delete(connexion));
    if (scenario === 'fermeture') {
      connexion.end();
      return;
    }
    let tampon = '';
    connexion.on('data', (morceau) => {
      tampon += morceau.toString();
      const fin = tampon.indexOf('\n');
      if (fin < 0) return;
      const ligne = tampon.slice(0, fin);
      lignes.push(ligne);
      const requete = JSON.parse(ligne) as { request_id: string };
      const succes = JSON.stringify({
        request_id: requete.request_id,
        ok: true,
        status: 200,
        body: {},
      });
      if (typeof scenario === 'object')
        connexion.end(
          JSON.stringify({ request_id: requete.request_id, ...scenario.reponse }) + '\n',
        );
      else if (scenario === 'request_id_faux')
        connexion.end(
          JSON.stringify({ request_id: 'autre', ok: true, status: 200, body: {} }) + '\n',
        );
      else if (scenario === 'fermeture_apres_ligne') connexion.end();
      else if (scenario === 'illisible') connexion.end('illisible\n');
      else if (scenario === 'trop_longue') connexion.end('é'.repeat(512 * 1024 + 1) + '\n');
      else if (scenario === 'deux_lignes') connexion.end(succes + '\nillisible\n');
      else if (scenario === 'fragmentee') {
        connexion.write(succes.slice(0, 10));
        setImmediate(() => connexion.end(succes.slice(10) + '\n'));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    serveur.once('error', reject);
    serveur.listen(socket, resolve);
  });
  return {
    socket,
    lignes,
    get nombreConnexions() {
      return nombreConnexions;
    },
    get connexionsActives() {
      return connexions.size;
    },
    async fermer() {
      for (const connexion of connexions) connexion.destroy();
      await new Promise<void>((resolve, reject) =>
        serveur.close((erreur) => (erreur ? reject(erreur) : resolve())),
      );
      await rm(dossier, { recursive: true, force: true });
    },
  };
}
