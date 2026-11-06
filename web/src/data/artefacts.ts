import type { ArtefactsResponse, LienArtefact } from '../../../src/shared/artefacts.js';
import type { Call } from './memory.js';

// Chantier 30 : la liste (D161) et le lien vers le second port (D163).
export function fetchArtefacts(call: Call, topicId: string): Promise<ArtefactsResponse> {
  return call('GET', `/api/topics/${topicId}/artefacts`);
}

export function demanderLien(call: Call, topicId: string, path: string): Promise<LienArtefact> {
  return call('POST', `/api/topics/${topicId}/artefacts/lien`, { path });
}
