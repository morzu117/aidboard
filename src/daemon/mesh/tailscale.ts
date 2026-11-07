import { execFile } from 'node:child_process';
import type { LectureServe, LectureTailnet } from '../../shared/host.js';
import type { MeshTailscale } from '../../shared/model.js';

/** `tailscale status --json` : `BackendState` vaut `Running`, `Stopped`, `NeedsLogin`… (D37 : lu, jamais piloté ici). */
export function parseTailscaleStatus(stdout: string): MeshTailscale {
  try {
    const parsed = JSON.parse(stdout) as { BackendState?: unknown };
    return parsed.BackendState === 'Running' ? 'running' : 'stopped';
  } catch {
    return 'stopped';
  }
}

export type TailscaleExec = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; code: string | null }>;

const realExec: TailscaleExec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve({
        stdout: String(stdout ?? ''),
        code: err ? ((err as NodeJS.ErrnoException).code ?? 'ERR') : null,
      }),
    );
  });

/** Binaire absent ⇒ `absent` ; sinon l'état que le JSON annonce (un `status` en code 1 reste lisible quand l'app est arrêtée). */
export async function tailscaleState(
  bin: string,
  exec: TailscaleExec = realExec,
): Promise<MeshTailscale> {
  const { stdout, code } = await exec(bin, ['status', '--json']);
  if (code === 'ENOENT' || code === 'EACCES') return 'absent';
  if (stdout.trim() === '') return code === null ? 'stopped' : 'absent';
  return parseTailscaleStatus(stdout);
}

// Chantier 31 (D173) : ce que le mode host lit de Tailscale. Lu, jamais piloté (D37) : A-I-D ne
// lance ni `tailscale serve` ni `tailscale funnel`.

/** `tailscale status --json` : le nom `.ts.net` du Mac et le login de son compte. */
export function parseTailnet(stdout: string): LectureTailnet {
  try {
    const parsed = JSON.parse(stdout) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown; UserID?: unknown };
      User?: Record<string, { LoginName?: unknown } | undefined>;
    };
    const etat = parsed.BackendState === 'Running' ? 'running' : 'stopped';
    const dns = parsed.Self?.DNSName;
    const nom = typeof dns === 'string' && dns !== '' ? dns.replace(/\.$/, '') : null;
    const uid = parsed.Self?.UserID;
    const login =
      typeof uid === 'number' || typeof uid === 'string'
        ? parsed.User?.[String(uid)]?.LoginName
        : null;
    // un nœud taggé n'a pas de compte d'utilisateur : Tailscale y met un login de service
    const compte =
      typeof login === 'string' && login !== '' && login !== 'tagged-devices' ? login : null;
    return {
      etat,
      nom: etat === 'running' ? nom : null,
      compte: etat === 'running' ? compte : null,
    };
  } catch {
    return { etat: 'stopped', nom: null, compte: null };
  }
}

export async function lireTailnet(
  bin: string,
  exec: TailscaleExec = realExec,
): Promise<LectureTailnet> {
  const { stdout, code } = await exec(bin, ['status', '--json']);
  if (code === 'ENOENT' || code === 'EACCES') return { etat: 'absent', nom: null, compte: null };
  if (stdout.trim() === '')
    return { etat: code === null ? 'stopped' : 'absent', nom: null, compte: null };
  return parseTailnet(stdout);
}

/** Un proxy de Serve vers ce Mac : `http://127.0.0.1:4890`, `localhost:4890` ou `4890`. */
function portLocal(proxy: string): number | null {
  const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])?:?(\d{1,5})\/?$/.exec(
    proxy.trim(),
  );
  return m ? Number(m[1]) : null;
}

/**
 * `tailscale serve status --json` (la `ServeConfig` de Tailscale) : `Web` donne, par
 * `<nom>:<port>`, des `Handlers` avec un `Proxy` ; `AllowFunnel` dit lesquels sont sur internet.
 * `TCP` peut aussi transférer un port brut (`TCPForward`). Défensif : un champ inconnu est ignoré.
 */
export function parseServe(
  stdout: string,
  ports: { appareils: number; interdits: number[] },
): LectureServe {
  if (stdout.trim() === '') return { etat: 'absent', funnel: false, interdits: [] };
  let parsed: {
    TCP?: Record<string, { HTTPS?: unknown; TCPForward?: unknown } | null>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> } | null>;
    AllowFunnel?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { etat: 'illisible', funnel: false, interdits: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { etat: 'illisible', funnel: false, interdits: [] };
  }
  const vises: Array<{ port: number; https: boolean }> = [];
  for (const [hotePort, web] of Object.entries(parsed.Web ?? {})) {
    const portPublic = hotePort.split(':').pop() ?? '';
    const https = parsed.TCP?.[portPublic]?.HTTPS === true;
    for (const h of Object.values(web?.Handlers ?? {})) {
      const p = typeof h?.Proxy === 'string' ? portLocal(h.Proxy) : null;
      if (p !== null) vises.push({ port: p, https });
    }
  }
  for (const tcp of Object.values(parsed.TCP ?? {})) {
    const p = typeof tcp?.TCPForward === 'string' ? portLocal(tcp.TCPForward) : null;
    if (p !== null) vises.push({ port: p, https: false });
  }
  const funnel = Object.values(parsed.AllowFunnel ?? {}).some((v) => v === true);
  const interdits = [
    ...new Set(vises.map((v) => v.port).filter((p) => ports.interdits.includes(p))),
  ].sort((a, b) => a - b);
  const ok = vises.some((v) => v.port === ports.appareils && v.https);
  const etat = ok ? 'ok' : vises.length === 0 && funnel === false ? 'absent' : 'autre';
  return { etat, funnel, interdits };
}

export async function lireServe(
  bin: string,
  ports: { appareils: number; interdits: number[] },
  exec: TailscaleExec = realExec,
): Promise<LectureServe> {
  const { stdout, code } = await exec(bin, ['serve', 'status', '--json']);
  if (code === 'ENOENT' || code === 'EACCES')
    return { etat: 'absent', funnel: false, interdits: [] };
  return parseServe(stdout, ports);
}

/** D173 : la commande à copier ; A-I-D ne la lance jamais. */
export function commandeServe(port: number): string {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}
