import type { FileContentResponse, FilesResponse } from '../../../src/shared/files.js';
import type { Call } from './memory.js';

export function fetchFileTree(
  call: Call,
  topicId: string,
  scope: 'tout' | 'modifies',
): Promise<FilesResponse> {
  return call('GET', `/api/topics/${topicId}/files?scope=${scope}`);
}

export function fetchFileContent(
  call: Call,
  topicId: string,
  path: string,
): Promise<FileContentResponse> {
  return call('GET', `/api/topics/${topicId}/files/content?path=${encodeURIComponent(path)}`);
}
