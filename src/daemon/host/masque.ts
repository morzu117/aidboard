import type { EtatPourAppareil, RaisonAppareil } from '../../shared/host.js';
import type { StateSnapshot } from '../../shared/state.js';

// Chantier 31 (D175) : l'état d'un appareil, par liste d'autorisation, champ par champ. Jamais
// une copie de l'objet suivie d'un retrait : ce qui n'est pas nommé ici ne sort pas.

/** `statusReason` est un texte que l'agent fournit (projectors.ts) : ramené à une liste fermée. */
export function raisonAppareil(r: string | null): RaisonAppareil | null {
  if (r === null) return null;
  if (r === 'permission' || r === 'question') return r;
  return 'autre';
}

export function etatPourAppareil(s: StateSnapshot): EtatPourAppareil {
  const sortie: EtatPourAppareil = {
    lastEventId: s.lastEventId,
    workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name })),
    // sans chemin : ni worktree, ni base, ni index, ni lien de PR, ni stash
    topics: s.topics.map((t) => ({
      id: t.id,
      workspaceId: t.workspaceId,
      slug: t.slug,
      title: t.title,
      type: t.type,
      branch: t.branch,
      state: t.state,
      phase: t.phase,
      prNumber: t.prNumber,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    runs: s.runs.map((r) => ({
      id: r.id,
      topicId: r.topicId,
      state: r.state,
      createdAt: r.createdAt,
    })),
    // ni le nom de l'action, ni son résultat
    actions: s.actions.map((a) => ({
      id: a.id,
      topicId: a.topicId,
      state: a.state,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    })),
    // jamais command, cwd, statusMessage, statusDetail, lastTool, pending, sessionId, pid
    agents: s.agents.map((a) => ({
      id: a.id,
      runId: a.runId,
      kind: a.kind,
      role: a.role,
      transport: a.transport,
      status: a.status,
      statusReason: raisonAppareil(a.statusReason),
      statusAt: a.statusAt,
      pausedAt: a.pausedAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      attend: a.pending !== null,
    })),
  };
  if (s.mesh) {
    const m = s.mesh.state;
    sortie.mesh = {
      state: {
        connected: m.connected,
        tailscale: m.tailscale,
        monitor: m.monitor,
        pending: m.pending,
        since: m.since,
        cell: m.cell,
      },
      // jamais content, ni le fil, ni l'obligation
      inbox: s.mesh.inbox.map((d) => ({
        id: d.id,
        from: d.from,
        kind: d.kind,
        createdAt: d.createdAt,
        seenAt: d.seenAt,
      })),
    };
  }
  return sortie;
}
