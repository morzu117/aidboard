import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { creerRelais } from '../../relais/index.js';

export async function runRelais(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: 'string' },
        origine: { type: 'string' },
        'cle-daemon': { type: 'string' },
        hote: { type: 'string', default: '127.0.0.1' },
        'confiance-proxy': { type: 'boolean', default: false },
      },
    });
    if (
      !values.port ||
      !/^\d{1,5}$/.test(values.port) ||
      Number(values.port) < 1 ||
      Number(values.port) > 65535 ||
      !values.origine ||
      !values['cle-daemon']
    )
      throw new Error('Options requises');
    const serveur = createServer(
      creerRelais({
        origineApp: values.origine,
        cleDaemon: values['cle-daemon'],
        confianceProxy: values['confiance-proxy'],
      }),
    );
    serveur.requestTimeout = 15000;
    serveur.headersTimeout = 10000;
    serveur.maxRequestsPerSocket = 100;
    await new Promise<void>((resolve, reject) => {
      serveur.once('error', reject);
      serveur.listen(Number(values.port), values.hote, resolve);
    });
    return -1;
  } catch {
    console.error(
      'Usage : aid relais --port <n> --origine <https://…> --cle-daemon <raw> [--hote 127.0.0.1] [--confiance-proxy]',
    );
    return 1;
  }
}
