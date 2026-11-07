import type { Db } from '../db.js';
import type { AbonnementPush } from './envoi.js';

/** L'échéance est nettoyée à chaque lecture, même sans nouvelle requête de l'appareil. */
export function abonnementsActifs(
  db: Db,
  maintenant: number,
): Array<AbonnementPush & { appareilId: string }> {
  const instant = new Date(maintenant).toISOString();
  db.prepare(
    `DELETE FROM push_abonnements WHERE appareil_id IN
    (SELECT id FROM appareils WHERE revoque_a IS NOT NULL OR expire_a <= ?)`,
  ).run(instant);
  return db
    .prepare(
      `SELECT p.appareil_id AS appareilId, p.endpoint, p.p256dh, p.auth
    FROM push_abonnements p JOIN appareils a ON a.id = p.appareil_id
    WHERE a.revoque_a IS NULL AND a.expire_a > ?`,
    )
    .all(instant) as Array<AbonnementPush & { appareilId: string }>;
}

export const CorpsAbonnementPush = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint', 'keys'],
  properties: {
    endpoint: { type: 'string', maxLength: 2048 },
    keys: {
      type: 'object',
      additionalProperties: false,
      required: ['p256dh', 'auth'],
      properties: {
        p256dh: { type: 'string', pattern: '^[A-Za-z0-9_-]{87}$' },
        auth: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' },
      },
    },
  },
} as const;

export function cleAbonnementValide(cle: string, taille: number): boolean {
  const octets = Buffer.from(cle, 'base64url');
  return (
    octets.length === taille &&
    octets.toString('base64url') === cle &&
    (taille !== 65 || octets[0] === 4)
  );
}
