import type { Db } from '../db.js';

export const RETRO_MAX_FAILED_NIGHTS = 3;

export const CYCLES_TERMINES = `
  FROM topics t JOIN workspaces w ON w.id = t.workspace_id
  WHERE t.state IN ('merged', 'archived')`;

const cibleRetro = "(COALESCE(w.namespace, w.name) || '/retro/' || t.slug)";
const retroVue = `EXISTS (
  SELECT 1 FROM memory_maintenance_seen s WHERE s.slug = ${cibleRetro} AND s.kind = 'retro'
)`;

export const RETRO_MANQUANTE = `
  NOT EXISTS (SELECT 1 FROM memory_pages p WHERE p.slug = ${cibleRetro})
  AND NOT EXISTS (
    SELECT 1 FROM memory_proposals p WHERE p.slug = ${cibleRetro} AND p.kind = 'retro'
  )
  AND NOT ${retroVue}`;

export const PLAFOND_ECHECS_RETRO = `(SELECT count(*) FROM memory_jobs j
    WHERE j.slug = t.id AND j.kind = 'retro' AND j.state = 'failed') >= ${RETRO_MAX_FAILED_NIGHTS}`;

// Un sujet abandonné (note `seen` ou plafond d'échecs) n'est pas compté comme manquant.
export function compterRetros(db: Db) {
  return db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE ${RETRO_MANQUANTE} AND NOT ${PLAFOND_ECHECS_RETRO}) AS manquantes,
         (SELECT count(*) FROM memory_proposals WHERE kind = 'retro' AND state = 'open') AS proposees,
         count(*) FILTER (WHERE ${retroVue} OR ${PLAFOND_ECHECS_RETRO}) AS abandonnees
       ${CYCLES_TERMINES}`,
    )
    .get() as { manquantes: number; proposees: number; abandonnees: number };
}
