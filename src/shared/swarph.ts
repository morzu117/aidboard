import type { Parsed } from './board.js';

export interface PairSwarph {
  nom: string;
  version: string;
}

export interface DroitSwarph {
  grant_type: string | null;
  target: string | null;
  level: string | null;
  direct: boolean | null;
}

export interface DroitsSwarph {
  peer: string | null;
  groups: string[];
  grants: DroitSwarph[];
}

export interface LigneCodegraph {
  repo: string | null;
  name: string;
  kind: string | null;
  file_path: string | null;
  start_line: number | null;
  callers: number | null;
  qualified_name: string | null;
  signature: string | null;
  docstring: string | null;
}

export interface ResumeMemoire {
  slug: string;
  title: string | null;
  type: string | null;
  tags: string[];
}

export interface PageMemoire extends ResumeMemoire {
  content: string | null;
}

export interface LienMemoire {
  from: string;
  to: string;
  direction: string | null;
  hop: number | null;
}

type Objet = Record<string, unknown>;
const objet = (v: unknown): v is Objet => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;
const chaines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const couper = (v: unknown, limite = 300): string | null => str(v)?.slice(0, limite) ?? null;
const compacter = <T>(valeurs: (T | null)[]): T[] => valeurs.filter((v): v is T => v !== null);
const parsed = <T>(racine: unknown, value: T): Parsed<T> => ({
  value,
  schemaVersion:
    objet(racine) &&
    (typeof racine.schema_version === 'string' || typeof racine.schema_version === 'number')
      ? String(racine.schema_version)
      : null,
});

export const parsePeers = (texte: unknown): Parsed<PairSwarph[]> | null => {
  if (typeof texte !== 'string') return null;
  const pairs: PairSwarph[] = [];
  for (const ligne of texte.split(/\r?\n/)) {
    if (!ligne.trim()) continue;
    const colonnes = ligne.trim().split(/\s+/);
    if (colonnes.length !== 2) return null;
    pairs.push({ nom: colonnes[0]!, version: colonnes[1]! });
  }
  return parsed(texte, pairs);
};

export const parseRights = (json: unknown): Parsed<DroitsSwarph> | null => {
  if (!objet(json)) return null;
  return parsed(json, {
    peer: str(json.peer),
    groups: chaines(json.groups),
    grants: Array.isArray(json.grants)
      ? compacter(
          json.grants.map((d): DroitSwarph | null => {
            if (!objet(d)) return null;
            return {
              grant_type: str(d.grant_type),
              target: str(d.target),
              level: str(d.level),
              direct:
                d.direct === undefined
                  ? d.via_group === null
                  : typeof d.direct === 'boolean'
                    ? d.direct
                    : null,
            };
          }),
        )
      : [],
  });
};

/** Le signal d'index périmé est lu sur stderr par le lecteur, pas ici. */
export const parseCodegraph = (json: unknown): Parsed<LigneCodegraph[]> | null => {
  if (!Array.isArray(json)) return null;
  return parsed(
    json,
    compacter(
      json.map((ligne): LigneCodegraph | null => {
        if (!objet(ligne) || !str(ligne.name)) return null;
        return {
          repo: couper(ligne.repo),
          name: couper(ligne.name)!,
          kind: couper(ligne.kind),
          file_path: couper(ligne.file_path),
          start_line: int(ligne.start_line),
          callers: int(ligne.callers),
          qualified_name: couper(ligne.qualified_name),
          signature: couper(ligne.signature),
          docstring: couper(ligne.docstring, 500),
        };
      }),
    ),
  );
};

const resumeMemoire = (json: unknown): ResumeMemoire | null => {
  if (!objet(json)) return null;
  const slug = str(json.slug);
  if (!slug) return null;
  return { slug, title: str(json.title), type: str(json.type), tags: chaines(json.tags) };
};

export const parseMemoryList = (json: unknown): Parsed<ResumeMemoire[]> | null => {
  if (!Array.isArray(json)) return null;
  return parsed(json, compacter(json.map(resumeMemoire)));
};

export const parseMemoryPage = (json: unknown): Parsed<PageMemoire> | null => {
  const resume = resumeMemoire(json);
  if (!resume || !objet(json)) return null;
  return parsed(json, {
    ...resume,
    content: couper(str(json.compiled_truth) ?? str(json.content), 200_000),
  });
};

export const parseMemoryLinks = (json: unknown): Parsed<LienMemoire[]> | null => {
  if (!Array.isArray(json)) return null;
  return parsed(
    json,
    compacter(
      json.map((lien): LienMemoire | null => {
        if (!objet(lien)) return null;
        const de = str(lien.from);
        const vers = str(lien.to);
        if (!de || !vers) return null;
        return { from: de, to: vers, direction: str(lien.direction), hop: int(lien.hop) };
      }),
    ),
  );
};

export const requeteCodegraphValide = (valeur: unknown): valeur is string =>
  typeof valeur === 'string' &&
  valeur.length >= 1 &&
  valeur.length <= 200 &&
  !valeur.startsWith('-') &&
  !/\p{Cc}/u.test(valeur);

export const slugValide = (valeur: unknown): valeur is string =>
  typeof valeur === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(valeur);

export const tagValide = slugValide;
