import type { GitCommitDetail, GitLogResponse, LivraisonGit } from '../../../src/shared/git.js';
import type { Call } from './memory.js';

export function fetchGitLog(call: Call, topicId: string): Promise<GitLogResponse> {
  return call('GET', `/api/topics/${topicId}/git/log`);
}

export function fetchCommitDetail(
  call: Call,
  topicId: string,
  hash: string,
): Promise<GitCommitDetail> {
  return call('GET', `/api/topics/${topicId}/git/commits/${encodeURIComponent(hash)}`);
}

/** Chantier 27 (D125) : le changement livré ; `revue` situe le commit d'une revue par rapport à HEAD. */
export function fetchLivraison(call: Call, topicId: string, revue?: string): Promise<LivraisonGit> {
  const q = revue ? `?revue=${encodeURIComponent(revue)}` : '';
  return call('GET', `/api/topics/${topicId}/git/livraison${q}`);
}
