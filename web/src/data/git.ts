import type { GitCommitDetail, GitLogResponse } from '../../../src/shared/git.js';
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
