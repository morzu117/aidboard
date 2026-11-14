import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isMap, parseDocument } from 'yaml';
import { ConfigError, nomMeshValide, parseConfig } from '../config.js';
import type { AidPaths } from '../paths.js';

/** D335 : relire le fichier actuel, préserver ses nœuds YAML et valider avant toute écriture. */
function modifierMesh(
  paths: AidPaths,
  nom: string,
  ajout?: { cell: string; gateway: string; home?: string },
): void {
  if (!nomMeshValide(nom)) throw new ConfigError('Nom de mesh invalide');
  if (nom === 'principal') throw new ConfigError('principal ne peut pas être modifié ici');
  let texte: string;
  try {
    texte = existsSync(paths.config) ? readFileSync(paths.config, 'utf8') : '';
  } catch {
    throw new ConfigError("config.yaml illisible : rien n'est écrit");
  }
  const doc = parseDocument(texte);
  if (doc.errors.length > 0) throw new ConfigError("config.yaml illisible : rien n'est écrit");
  let config;
  try {
    config = parseConfig(texte);
  } catch {
    throw new ConfigError("config.yaml invalide : rien n'est écrit");
  }
  if (ajout && Object.hasOwn(config.meshes, nom)) throw new ConfigError('Mesh déjà configuré');
  if (!ajout && !Object.hasOwn(config.meshes, nom)) throw new ConfigError('Mesh inconnu');
  try {
    if (!doc.has('meshes')) {
      // D311 : conserver principal, y compris ses commentaires et chemins personnalisés.
      doc.set('meshes', doc.createNode({ principal: {} }));
      const ancien = doc.get('mesh', true);
      if (isMap(ancien)) {
        for (const paire of [...ancien.items]) {
          const cle = String(paire.key);
          if (cle === 'bin' || cle === 'tailscale') continue;
          const principal = doc.getIn(['meshes', 'principal'], true);
          if (isMap(principal)) principal.items.push(paire);
          ancien.delete(cle);
        }
      }
    }
    if (ajout) doc.setIn(['meshes', nom], ajout);
    else doc.deleteIn(['meshes', nom]);
    texte = doc.toString();
    parseConfig(texte);
  } catch {
    throw new ConfigError("config.yaml invalide : rien n'est écrit");
  }
  // writeFileSync garde les droits du fichier existant ; un nouveau fichier est privé.
  writeFileSync(paths.config, texte, { mode: 0o600 });
}

export function ajouterMesh(
  paths: AidPaths,
  nom: string,
  config: { cell: string; gateway: string; home?: string },
): void {
  modifierMesh(paths, nom, config);
}

/** Aucun accès au jeton ni au fichier join.json. */
export function oublierMesh(paths: AidPaths, nom: string): void {
  modifierMesh(paths, nom);
}
