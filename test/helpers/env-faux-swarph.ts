import { afterAll, beforeEach, vi } from 'vitest';
import * as execution from '../../src/daemon/mesh/exec.js';

/** Les commandes de contrôle du faux binaire sont injectées par le test, hors du daemon. */
export function injecterEnvFauxSwarph(): void {
  const executer = execution.meshExec;
  beforeEach(() => {
    vi.spyOn(execution, 'meshExec').mockImplementation((bin, args, options) =>
      executer(bin, args, {
        ...options,
        env: {
          ...options.env,
          ...Object.fromEntries(
            Object.entries(process.env).filter(([nom]) => nom.startsWith('FAKE_SWARPH_')),
          ),
        },
      }),
    );
  });
  afterAll(() => vi.restoreAllMocks());
}
