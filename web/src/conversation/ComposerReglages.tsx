import { useEffect, useRef, useState } from 'react';
import {
  CLAUDE_MODELS,
  MODES,
  type AgentOptions,
  type AgentSettings,
} from '../../../src/shared/agentSettings.js';
import { REMOTE_CONTROL, type RemoteControlState } from '../../../src/shared/agentSettings.js';
import { useAid } from '../data/useAidState.js';
import { useAgentRoutes } from './routes.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const PAR_DEFAUT = 'Par défaut';

type Menu = 'mode' | 'modele' | 'remote' | null;

/** Chantier 23 (D91) : le libellé du chip, d'après l'état du remote-control. */
const LIBELLE_REMOTE: Record<RemoteControlState['status'], string> = {
  unsupported: 'Remote',
  off: 'Remote',
  connecting: 'Remote · connexion…',
  connected: 'Remote · connecté',
  error: 'Remote · erreur',
};

// Chips « mode » et « modèle · effort » du composer (brief §5.3, D66-D71) : un agent `stream` seulement.
export function ComposerReglages({
  agentId,
  kind,
  settings,
  onErreur,
  dataNode,
}: {
  agentId: string;
  kind: 'claude' | 'codex';
  settings: AgentSettings;
  onErreur: (erreur: string | null) => void;
  dataNode: string;
}) {
  const { call } = useAid();
  const { api } = useAgentRoutes();
  const [options, setOptions] = useState<AgentOptions | null>(null);
  // réglage affiché avant que l'instantané ne le confirme ; l'instantané reprend la main dès qu'il change
  const [attente, setAttente] = useState<AgentSettings | null>(null);
  const cle = `${settings.mode}|${settings.model}|${settings.effort}`;
  const [cleVue, setCleVue] = useState(cle);
  if (cleVue !== cle) {
    setCleVue(cle);
    setAttente(null);
  }
  const courant = attente ?? settings;
  const [menu, setMenu] = useState<Menu>(null);
  const ref = useRef<HTMLDivElement>(null);

  // D91 : l'état du remote-control, relu à l'ouverture et toutes les 3 s tant qu'il est en connexion
  const [remote, setRemote] = useState<RemoteControlState | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const lireRemote = () =>
    call<RemoteControlState>('GET', `${api}/${agentId}/remote-control`)
      .then(setRemote)
      .catch(() => setRemote(null));
  useEffect(() => {
    if (!REMOTE_CONTROL[kind]) return;
    void lireRemote();
    // même raison que pour le catalogue : `call` change d'identité à chaque rendu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, kind]);
  useEffect(() => {
    if (remote?.status !== 'connecting') return;
    const t = setInterval(() => void lireRemote(), 3_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.status, agentId]);
  const basculerRemote = async (enabled: boolean) => {
    setRemoteBusy(true);
    onErreur(null);
    try {
      setRemote(
        await call<RemoteControlState>('POST', `${api}/${agentId}/remote-control`, { enabled }),
      );
    } catch (err) {
      onErreur(message(err));
      void lireRemote();
    } finally {
      setRemoteBusy(false);
    }
  };
  const remoteActif = remote?.status === 'connecting' || remote?.status === 'connected';

  const charger = () =>
    call<AgentOptions>('GET', `${api}/${agentId}/options`)
      .then(setOptions)
      .catch((err: unknown) => onErreur(message(err)));
  useEffect(() => {
    void charger();
    // `call` change d'identité à chaque rendu : le suivre relirait le catalogue en boucle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const ouvrir = (m: Exclude<Menu, null>) => {
    if (m === 'remote') void lireRemote();
    // le catalogue codex arrive après la poignée de main : relu à chaque ouverture (D71)
    if (m === 'modele') void charger();
    setMenu(menu === m ? null : m);
  };

  const regler = async (patch: Partial<AgentSettings>) => {
    setAttente({ ...courant, ...patch });
    setMenu(null);
    onErreur(null);
    try {
      setAttente(await call<AgentSettings>('PATCH', `${api}/${agentId}/settings`, patch));
    } catch (err) {
      setAttente(null);
      onErreur(message(err));
    }
  };

  // catalogue statique en attendant la réponse : le chip affiche le bon libellé dès le premier rendu
  const modes = options?.modes ?? MODES[kind];
  const models = options?.models ?? (kind === 'claude' ? CLAUDE_MODELS : []);
  const modele = models.find((m) => m.id === courant.model);
  const efforts = modele?.efforts.length ? modele.efforts : (options?.efforts ?? []);
  const libelleMode = modes.find((m) => m.id === courant.mode)?.label ?? courant.mode;
  const libelleModele = `${modele?.label ?? courant.model ?? PAR_DEFAUT}${courant.effort ? ` · ${courant.effort}` : ''}`;

  const ligne = (key: string, label: string, checked: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="composer-menu-ligne"
      data-node={`${dataNode}.option-${key}`}
      onClick={onClick}
    >
      <span className="composer-menu-coche" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  );

  return (
    <div className="composer-reglages" ref={ref}>
      <button
        className="composer-chip"
        data-node={`${dataNode}.mode`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu === 'mode'}
        aria-label={`Mode : ${libelleMode}`}
        onClick={() => ouvrir('mode')}
      >
        ▸▸ {libelleMode}
      </button>
      <button
        className="composer-chip"
        data-node={`${dataNode}.modele`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu === 'modele'}
        aria-label={`Modèle : ${libelleModele}`}
        onClick={() => ouvrir('modele')}
      >
        {libelleModele}
      </button>
      {remote && remote.status !== 'unsupported' && (
        <button
          className="composer-chip composer-chip-remote"
          data-node={`${dataNode}.remote`}
          data-etat={remote.status}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu === 'remote'}
          aria-label={`Remote-control : ${LIBELLE_REMOTE[remote.status]}`}
          onClick={() => ouvrir('remote')}
        >
          {LIBELLE_REMOTE[remote.status]}
        </button>
      )}
      {menu === 'mode' && (
        <div className="composer-menu" role="menu" aria-label="Mode" data-node={`${dataNode}.menu`}>
          {modes.map((m) =>
            ligne(
              `mode-${m.id}`,
              m.label,
              m.id === courant.mode,
              () => void regler({ mode: m.id }),
            ),
          )}
        </div>
      )}
      {menu === 'remote' && remote && (
        <div
          className="composer-menu composer-menu-remote"
          role="menu"
          aria-label="Remote-control"
          data-node={`${dataNode}.menu`}
        >
          <p className="composer-menu-titre">Remote-control</p>
          <p className="composer-menu-texte" data-node={`${dataNode}.remote-etat`}>
            {remote.status === 'connected'
              ? 'Reprends la conversation depuis claude.ai/code ou l’application mobile.'
              : remote.status === 'connecting'
                ? 'Connexion en cours…'
                : remote.status === 'error'
                  ? (remote.error ?? 'Erreur de connexion')
                  : 'Ouvre cette conversation à claude.ai/code et à l’application mobile.'}
          </p>
          {remote.url && remoteActif && (
            <a
              className="composer-menu-ligne"
              role="menuitem"
              href={remote.url}
              target="_blank"
              rel="noreferrer noopener"
              data-node={`${dataNode}.remote-lien`}
            >
              <span className="composer-menu-coche" aria-hidden="true">
                ↗
              </span>
              Ouvrir la session
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            className="composer-menu-ligne"
            disabled={remoteBusy}
            data-node={`${dataNode}.remote-bascule`}
            onClick={() => void basculerRemote(!remoteActif)}
          >
            <span className="composer-menu-coche" aria-hidden="true" />
            {remoteActif ? 'Désactiver' : remote.status === 'error' ? 'Réessayer' : 'Activer'}
          </button>
        </div>
      )}
      {menu === 'modele' && (
        <div
          className="composer-menu"
          role="menu"
          aria-label="Modèle"
          data-node={`${dataNode}.menu`}
        >
          <p className="composer-menu-titre">Modèle</p>
          {ligne(
            'modele-defaut',
            PAR_DEFAUT,
            courant.model === null,
            () => void regler({ model: null }),
          )}
          {models.map((m) =>
            ligne(`modele-${m.id}`, m.label, m.id === courant.model, () => {
              // un effort que le nouveau modèle ne connaît pas repasse au défaut
              const garde =
                !courant.effort || !m.efforts.length || m.efforts.includes(courant.effort);
              void regler({ model: m.id, ...(garde ? {} : { effort: null }) });
            }),
          )}
          {efforts.length > 0 && (
            <>
              <p className="composer-menu-titre">Effort</p>
              {ligne(
                'effort-defaut',
                PAR_DEFAUT,
                courant.effort === null,
                () => void regler({ effort: null }),
              )}
              {efforts.map((e) =>
                ligne(`effort-${e}`, e, e === courant.effort, () => void regler({ effort: e })),
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
