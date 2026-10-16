import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { AidHttpError } from '../errors.js';
import { hooksStatus, installHooks, settingsPath } from '../hooks/claudeSettings.js';

const Install = Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false });

// Installer les hooks modifie la configuration Claude Code de l'utilisateur : seulement sur son clic confirmé.
export function registerHookRoutes(app: FastifyInstance, env: () => NodeJS.ProcessEnv): void {
  app.get('/api/hooks', async () => hooksStatus(settingsPath(env())));

  app.post('/api/hooks/install', { schema: { body: Install } }, async () => {
    const path = settingsPath(env());
    try {
      const r = installHooks(path);
      return { ...hooksStatus(path), changed: r.changed, backup: r.changed ? r.backup : undefined };
    } catch (err) {
      throw new AidHttpError(422, (err as Error).message);
    }
  });
}
