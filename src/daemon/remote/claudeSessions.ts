/* eslint-disable no-control-regex -- validation des chemins issus des transcriptions */
import type { ConversationEvent } from '../../shared/conversation.js';
import type { RemoteClaudeSession, Server } from '../../shared/model.js';
import { AidHttpError } from '../errors.js';
import { remoteExec, type TransportOptions } from './transport.js';

export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_HEADER_BYTES = 64 * 1024;

/** Le format Claude n'est pas contractuel : seules les entrées textuelles reconnues passent. */
export function parseClaudeTranscript(jsonl: string): {
  cwd: string | null;
  messages: ConversationEvent[];
} {
  let cwd: string | null = null;
  const messages: ConversationEvent[] = [];
  for (const line of jsonl.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || entry.isSidechain || entry.isMeta) continue;
      if (
        typeof entry.cwd === 'string' &&
        entry.cwd.startsWith('/') &&
        !/[\x00-\x1f\x7f]/.test(entry.cwd)
      )
        cwd ??= entry.cwd;
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const texts: string[] =
        typeof content === 'string'
          ? [content]
          : Array.isArray(content)
            ? content
                .filter(
                  (b: unknown) =>
                    b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
                )
                .map((b: { text?: unknown }) => (typeof b.text === 'string' ? b.text : ''))
            : [];
      const text = texts
        .filter(
          (t) =>
            !/^\s*<(?:command-name|local-command-stdout|system-reminder|command-message|local-command-caveat)(?:\s|>)/.test(
              t,
            ),
        )
        .join('\n')
        .trim();
      if (text) messages.push({ type: 'message', role: entry.type, text });
    } catch {
      // Ligne partielle (lecture bornée), inconnue ou invalide.
    }
  }
  return { cwd, messages };
}

export function requireClaude(server: Server): void {
  if (!server.detectedAgents?.includes('claude'))
    throw new AidHttpError(409, 'claude n’a pas été détecté sur ce serveur au dernier test');
}

/** Noms transmis par argv, contenu encodé : ni les chemins ni le JSONL ne sont interprétés par le shell. */
export async function listClaudeSessions(
  server: Server,
  transport: TransportOptions,
): Promise<RemoteClaudeSession[]> {
  requireClaude(server);
  const command = `if [ -d "$HOME/.claude/projects" ]; then find "$HOME/.claude/projects" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' -printf '%T@ %p\\0' | sort -zrn | head -z -n 20 | cut -z -d ' ' -f 2- | xargs -0 -r sh -c 'for f do printf "%s\\t%s\\t" "$(stat -c %Y -- "$f")" "$(basename -- "$f" .jsonl)"; head -c ${SESSION_HEADER_BYTES} -- "$f" | base64 -w 0; printf "\\n"; done' sh; fi`;
  const result = await remoteExec(server, command, { ...transport, maxBytes: 2 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated)
    throw new AidHttpError(502, 'lecture des sessions Claude impossible');
  const sessions: RemoteClaudeSession[] = [];
  for (const line of result.stdout.split('\n')) {
    const [mtime, id, encoded] = line.split('\t');
    if (!id || !CLAUDE_SESSION_ID.test(id) || !encoded || !/^\d+$/.test(mtime ?? '')) continue;
    const parsed = parseClaudeTranscript(Buffer.from(encoded, 'base64').toString('utf8'));
    const first = parsed.messages.find((m) => m.type === 'message' && m.role === 'user');
    if (!parsed.cwd) continue;
    sessions.push({
      id,
      cwd: parsed.cwd,
      title: first?.type === 'message' ? first.text.slice(0, 200) : 'Session Claude',
      updatedAt: new Date(Number(mtime) * 1000).toISOString(),
    });
  }
  return sessions;
}

export const SESSION_HISTORY_BYTES = 1024 * 1024;

/** L'en-tête fournit le cwd même quand seule la fin de la transcription tient dans la borne. */
export async function readClaudeSession(server: Server, id: string, transport: TransportOptions) {
  requireClaude(server);
  if (!CLAUDE_SESSION_ID.test(id))
    throw new AidHttpError(422, 'identifiant de session Claude invalide');
  const command = `if [ -d "$HOME/.claude/projects" ]; then find "$HOME/.claude/projects" -mindepth 2 -maxdepth 2 -type f -name '${id}.jsonl' -exec sh -c 'for f do printf "%s\\t" "$(wc -c < "$f")"; head -c ${SESSION_HEADER_BYTES} -- "$f" | base64 -w 0; printf "\\t"; tail -c ${SESSION_HISTORY_BYTES} -- "$f" | base64 -w 0; printf "\\n"; done' sh {} +; fi`;
  const result = await remoteExec(server, command, { ...transport, maxBytes: 2 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated)
    throw new AidHttpError(502, 'lecture de la session Claude impossible');
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) throw new AidHttpError(404, 'session Claude introuvable');
  if (lines.length !== 1)
    throw new AidHttpError(409, 'identifiant de session Claude présent dans plusieurs projets');
  const [size, header, tail] = lines[0]!.split('\t');
  if (!header || !tail || !/^\s*\d+$/.test(size ?? ''))
    throw new AidHttpError(502, 'transcription Claude illisible');
  const cwd = parseClaudeTranscript(Buffer.from(header, 'base64').toString('utf8')).cwd;
  if (!cwd) throw new AidHttpError(422, 'répertoire de la session Claude introuvable');
  const truncated = Number(size) > SESSION_HISTORY_BYTES;
  let text = Buffer.from(tail, 'base64').toString('utf8');
  // La première ligne de tail peut commencer au milieu d'une entrée, même si son suffixe est du JSON valide.
  if (truncated) text = text.slice(text.indexOf('\n') + 1);
  const messages = parseClaudeTranscript(text).messages;
  if (truncated)
    messages.unshift({
      type: 'message',
      role: 'assistant',
      text: 'Historique importé partiellement : seule la fin de la transcription (1 Mio maximum) est affichée.',
    });
  return { cwd, messages };
}
