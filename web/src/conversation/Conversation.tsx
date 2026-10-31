import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentSettings } from '../../../src/shared/agentSettings.js';
import type { Agent, AgentStatus } from '../../../src/shared/model.js';
import type { AgentStreamItem } from '../../../src/shared/conversation.js';
import { useAid } from '../data/useAidState.js';
import { AgentSocket, socketSur } from './agentSocket.js';
import { Composer } from './Composer.js';
import { ConfirmCard, type ConfirmResolution } from './ConfirmCard.js';
import { DecisionCard } from './DecisionCard.js';
import { MarkMenu } from './MarkMenu.js';
import { MarkRail, type QuestionRepere } from './MarkRail.js';
import { Message } from './Message.js';
import { useAgentRoutes } from './routes.js';
import { ToolCallGroup } from './ToolCallGroup.js';
import { buildTurns, tourInterrompu } from './thread.js';
import type { Block } from './thread.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
// Chantier 16 : seuls claude et codex en `stream` ont des réglages ; un agent d'avant la migration est en « Demander ».
const settingsOf = (a: Agent): AgentSettings | undefined =>
  a.transport === 'stream' && (a.kind === 'claude' || a.kind === 'codex')
    ? { mode: a.permissionMode ?? 'default', model: a.model ?? null, effort: a.effort ?? null }
    : undefined;
const SEUIL_BAS = 40;
const SEUIL_REPERE = 40;
// Le canal précédent a fermé (D65) ; ces statuts disent que l'agent est reparti sous le même id (A.6).
const REPART: ReadonlySet<AgentStatus> = new Set(['starting', 'working', 'needs_input']);
const heure = (at: string) =>
  new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/** R.6 (§11.3) : « Connexion perdue à 09:41 · reprise après 4 s · session retrouvée ». */
function ligneConnexion(b: Extract<Block, { kind: 'connexion' }>): string {
  if (b.etat === 'echec')
    return b.reason
      ? `Session introuvable sur le serveur : ${b.reason}`
      : 'Session introuvable sur le serveur';
  const perdue = `Connexion perdue à ${heure(b.at)}`;
  if (b.etat === 'perdue') return `${perdue} · reconnexion…`;
  const apres = Math.max(1, Math.round((b.afterMs ?? 0) / 1000));
  return `${perdue} · reprise après ${apres} s · ${b.sessionFound ? 'session retrouvée' : 'session relancée'}`;
}

// Une instance par agent, montée une fois et masquée au changement d'onglet, comme <Terminal> (D65).
export function Conversation({
  agent,
  visible,
  actionsHost,
}: {
  agent: Agent;
  visible: boolean;
  // correctif 3 (recette) : emplacement fourni par Sujet dans la rangée d'onglets, porté par
  // createPortal uniquement quand cette instance est l'agent actif — l'état reste ici.
  actionsHost?: HTMLDivElement | null;
}) {
  const { call } = useAid();
  // R.6 : agent de sujet par défaut ; sous l'écran Discussion, agent distant
  const { api, ws, distant } = useAgentRoutes();
  const [items, setItems] = useState<Map<number, AgentStreamItem>>(new Map());
  const [truncated, setTruncated] = useState(false);
  const [linked, setLinked] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [pill, setPill] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [markErreur, setMarkErreur] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const atBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const sockRef = useRef<AgentSocket | null>(null);
  // pas de rendu propre (A.6) : seul un futur changement de `agent.status` doit déclencher la relance
  const exitedRef = useRef(false);
  // R.6 : l'écran Discussion relit l'agent à chaque événement ; tenu par ref, le canal n'est pas rouvert pour lui
  const evenementRef = useRef(distant?.onEvent);
  useEffect(() => {
    evenementRef.current = distant?.onEvent;
  });
  // F.4 : même chose avec l'événement, pour l'actualisation du panneau du serveur
  const itemRef = useRef(distant?.onItem);
  useEffect(() => {
    itemRef.current = distant?.onItem;
  });
  // id stable mais unique par instance (D65 : une Conversation par agent, montée en permanence) —
  // `dn` est une constante littérale partagée par toutes les instances, donc impropre à un id DOM (review A.7)
  const raccourcisId = useId();

  const ouvrirSocket = useCallback(
    () =>
      new (socketSur(ws))(agent.id, {
        onHello: () => {},
        onHistory: (hist, trunc) => {
          setItems((m) => {
            const next = new Map(m);
            for (const it of hist) next.set(it.seq, it);
            return next;
          });
          setTruncated(trunc);
        },
        // réaction à un événement externe, pas une synchronisation dérivée du rendu : setState légitime ici
        onEvent: (it) => {
          setItems((m) => new Map(m).set(it.seq, it));
          if (!atBottomRef.current) setPill(true);
          evenementRef.current?.();
          itemRef.current?.(it);
        },
        onExit: () => {
          exitedRef.current = true;
        },
        onLink: setLinked,
      }),
    [agent.id, ws],
  );

  useEffect(() => {
    sockRef.current = ouvrirSocket();
    return () => sockRef.current?.close();
  }, [ouvrirSocket]);

  // reprise transparente (A.6) : le canal précédent a fermé, l'agent est reparti sous le même id
  useEffect(() => {
    if (!exitedRef.current || !REPART.has(agent.status)) return;
    exitedRef.current = false;
    sockRef.current?.close();
    sockRef.current = ouvrirSocket();
  }, [agent.status, ouvrirSocket]);

  const sorted = useMemo(() => [...items.values()].sort((a, b) => a.seq - b.seq), [items]);
  const turns = useMemo(() => buildTurns(sorted), [sorted]);
  // R.5 : l'issue d'une carte de confirmation, lue au fil (réponse de l'opérateur, d'une règle, ou demande close)
  const resolutions = useMemo(() => {
    const m = new Map<string, Exclude<ConfirmResolution, null>>();
    let ouvertes: string[] = [];
    for (const { event: e } of sorted)
      if (e.type === 'request') ouvertes.push(e.request.id);
      else if (e.type === 'request_answered')
        m.set(e.requestId, e.auto ? { answer: e.answer, auto: true } : { answer: e.answer });
      else if (e.type === 'request_cancelled' && !m.has(e.requestId))
        m.set(e.requestId, { cancelled: true });
      else if (e.type === 'turn_end' || e.type === 'exit') {
        // tour fini sans réponse au fil (redémarrage du daemon, lien perdu) : la demande est close
        for (const id of ouvertes) if (!m.has(id)) m.set(id, { cancelled: true });
        ouvertes = [];
      }
    return m;
  }, [sorted]);
  const toolSeqs = useMemo(
    () => turns.flatMap((t) => t.blocks.filter((b) => b.kind === 'tools').map((b) => b.seq)),
    [turns],
  );
  const allOpen = toolSeqs.length > 0 && toolSeqs.every((s) => openGroups.has(s));
  const toggleGroup = (seq: number) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  const toggleAll = () => setOpenGroups(allOpen ? new Set() : new Set(toolSeqs));

  // Repères de discussion (A.7) : une question = un message utilisateur, un par tour en tête.
  const questions = useMemo<QuestionRepere[]>(
    () =>
      turns.flatMap((t) => {
        const b = t.blocks[0];
        return b && b.kind === 'message' && b.role === 'user'
          ? [{ seq: b.seq, text: b.text, at: b.at, marked: b.marked === true }]
          : [];
      }),
    [turns],
  );

  // Dernière question dont le haut est au-dessus de `scrollTop + 40px` (§5.3.2), recalculée au défilement.
  const computeActive = useCallback(() => {
    const box = threadRef.current;
    if (!box || questions.length === 0) return;
    let cur = questions[0]!.seq;
    for (const q of questions) {
      const el = box.querySelector<HTMLElement>(`[data-repere="${q.seq}"]`);
      if (el && el.offsetTop <= box.scrollTop + SEUIL_REPERE) cur = q.seq;
    }
    setActive((prev) => (prev === cur ? prev : cur));
  }, [questions]);

  // Seule l'arrivée d'une nouvelle question recalcule la position par défaut : un changement
  // ailleurs dans le fil (marque, sortie d'outil) ne doit pas écraser la navigation j/k/clic en cours.
  useEffect(() => {
    computeActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- volontaire : voir le commentaire ci-dessus
  }, [questions.length]);

  // synchronisation DOM pure (mesure/scroll) : aucun setState ici, le pilote est le ref ci-dessus
  useEffect(() => {
    const el = threadRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [sorted.length, atBottom]);

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const bas = el.scrollHeight - el.scrollTop - el.clientHeight < SEUIL_BAS;
    atBottomRef.current = bas;
    setAtBottom(bas);
    if (bas) setPill(false);
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      computeActive();
    });
  };

  const allerEnBas = () => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setPill(false);
  };

  // Défilement vers une question (§5.3.2) : 16 px sous le haut, 'auto' si prefers-reduced-motion.
  const scrollToQuestion = (seq: number) => {
    const box = threadRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-repere="${seq}"]`);
    if (!box || !el) return;
    const reduit = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top: el.offsetTop - 16, behavior: reduit ? 'auto' : 'smooth' });
    setActive(seq);
  };

  // Pas d'optimisme (D65-A.7) : la bascule locale n'a lieu qu'après la réponse 200 de la route.
  // R.6 (§11.3) : dernier échec de reprise sans message ni reprise après lui, le seul à offrir « Reconnecter »
  const echecOuvert = useMemo(() => {
    let seq: number | null = null;
    for (const { seq: s, event: e } of sorted)
      if (e.type === 'resume_failed') seq = s;
      else if (e.type === 'connection_resumed' || (e.type === 'message' && e.role === 'user'))
        seq = null;
    return seq;
  }, [sorted]);
  // issue de « Reconnecter », attachée à la ligne d'échec qui l'a offert : un nouvel échec repart de zéro
  const [tentative, setTentative] = useState<{ seq: number; etat: string } | null>(null);
  const reconnexion = tentative !== null && tentative.seq === echecOuvert ? tentative.etat : null;
  const reconnecter = async () => {
    if (echecOuvert === null) return;
    const seq = echecOuvert;
    setTentative({ seq, etat: 'en-cours' });
    try {
      await call('POST', `${api}/${agent.id}/reconnect`);
      // l'agent est relancé ; sa ligne d'échec le dit, plutôt que de laisser le bouton comme si rien n'avait eu lieu
      setTentative({ seq, etat: 'ok' });
    } catch (err) {
      setTentative({ seq, etat: message(err) });
    }
  };

  const toggleMark = async (seq: number, marked: boolean) => {
    try {
      await call('PUT', `${api}/${agent.id}/messages/${seq}/mark`, { marked });
      setMarkErreur(null);
      setItems((m) => {
        const it = m.get(seq);
        if (!it) return m;
        const next = new Map(m);
        next.set(seq, { ...it, marked });
        return next;
      });
    } catch (err) {
      setMarkErreur(message(err));
    }
  };

  const closeMenu = useCallback((renvoyerFocus: boolean) => {
    setMenuOpen(false);
    if (renvoyerFocus) menuBtnRef.current?.focus();
  }, []);

  // Raccourcis actifs seulement quand le fil a le focus (jamais le composer), sans Ctrl/Meta/Alt (décision 8).
  // Un champ éditable descendant du fil (saisie en cours de composition incluse) n'est pas visé par les
  // raccourcis : seuls les contrôles non éditables du fil (étoile, boutons de décision…) le sont (review A.7).
  const onThreadKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const cible = e.target as HTMLElement;
    if (
      cible.tagName === 'INPUT' ||
      cible.tagName === 'TEXTAREA' ||
      cible.tagName === 'SELECT' ||
      cible.isContentEditable
    )
      return;
    if (e.ctrlKey || e.metaKey || e.altKey || questions.length === 0) return;
    const idx = active === null ? -1 : questions.findIndex((q) => q.seq === active);
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      const dir = e.key === 'j' ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(questions.length - 1, idx + dir));
      scrollToQuestion(questions[nextIdx]!.seq);
    } else if (e.key === 'm') {
      e.preventDefault();
      const q = questions[Math.max(idx, 0)];
      if (q) void toggleMark(q.seq, !q.marked);
    } else if (e.key === 'e') {
      e.preventDefault();
      const q = questions[Math.max(idx, 0)];
      const turn = q && turns.find((t) => t.id === q.seq);
      if (!turn) return;
      const seqs = turn.blocks.filter((b) => b.kind === 'tools').map((b) => b.seq);
      if (seqs.length === 0) return;
      const toutOuvert = seqs.every((s) => openGroups.has(s));
      setOpenGroups((prev) => {
        const next = new Set(prev);
        for (const s of seqs)
          if (toutOuvert) next.delete(s);
          else next.add(s);
        return next;
      });
    }
  };

  const dn = '1-3.conversation';

  return (
    <div className={visible ? 'conversation' : 'conversation masque'} data-node={dn}>
      {truncated && (
        <p className="conversation-bandeau" data-node={`${dn}.tronque`}>
          Historique tronqué : les messages les plus anciens ne sont pas affichés.
        </p>
      )}
      {!linked && (
        <div className="conversation-barre" data-node={`${dn}.barre`}>
          <span className="texte-faible" data-node={`${dn}.reconnexion`}>
            reconnexion…
          </span>
        </div>
      )}
      {visible &&
        actionsHost &&
        createPortal(
          <>
            {questions.length > 0 && (
              <button
                ref={menuBtnRef}
                className="bouton"
                data-node={`${dn}.reperes`}
                type="button"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                Repères · {active === null ? 1 : questions.findIndex((q) => q.seq === active) + 1}/
                {questions.length} ▾
              </button>
            )}
            {toolSeqs.length > 0 && (
              <button className="bouton" data-node={`${dn}.tout`} type="button" onClick={toggleAll}>
                {allOpen ? 'Tout replier' : 'Tout déplier'}
              </button>
            )}
          </>,
          actionsHost,
        )}
      <div className="conversation-fil-zone">
        <div
          className="fil-conversation"
          data-node={`${dn}.fil`}
          ref={threadRef}
          tabIndex={0}
          role="log"
          aria-label="Fil de conversation"
          aria-describedby={raccourcisId}
          onScroll={onScroll}
          onKeyDown={onThreadKeyDown}
        >
          <p className="visuellement-cache" id={raccourcisId}>
            j et k : question suivante ou précédente, m : marquer, e : détail
          </p>
          {turns.map((t) => (
            <div className="tour" key={t.id} data-node={`${dn}.tour-${t.id}`}>
              {t.blocks.map((b) => {
                const bn = `${dn}.tour-${t.id}.b-${b.seq}`;
                switch (b.kind) {
                  case 'message':
                    return (
                      <Message
                        key={bn}
                        role={b.role}
                        text={b.text}
                        kind={agent.kind}
                        at={b.at}
                        seq={b.seq}
                        marked={b.marked}
                        attachments={b.attachments}
                        onToggleMark={(seq, m) => void toggleMark(seq, m)}
                        dataNode={bn}
                      />
                    );
                  case 'tools':
                    return (
                      <ToolCallGroup
                        key={bn}
                        calls={b.calls}
                        open={openGroups.has(b.seq)}
                        onToggle={() => toggleGroup(b.seq)}
                        dataNode={bn}
                      />
                    );
                  case 'decision':
                    if (b.request.confirm)
                      return (
                        <ConfirmCard
                          key={bn}
                          agentId={agent.id}
                          request={b.request}
                          resolution={resolutions.get(b.request.id) ?? null}
                          dataNode={bn}
                        />
                      );
                    return (
                      <DecisionCard
                        key={bn}
                        agentId={agent.id}
                        request={b.request}
                        resolved={
                          distant
                            ? resolutions.has(b.request.id)
                            : agent.pending?.id !== b.request.id
                        }
                        dataNode={bn}
                      />
                    );
                  case 'connexion':
                    return (
                      <p
                        className={`ligne-connexion ligne-connexion--${b.etat}`}
                        key={bn}
                        data-node={bn}
                        role={b.etat === 'echec' ? 'alert' : undefined}
                      >
                        <span className="ligne-connexion-point" aria-hidden="true" />
                        {ligneConnexion(b)}
                        {b.etat === 'echec' &&
                          distant &&
                          b.seq === echecOuvert &&
                          reconnexion !== 'ok' && (
                            <button
                              className="bouton"
                              data-node={`${bn}.reconnecter`}
                              type="button"
                              disabled={reconnexion === 'en-cours'}
                              onClick={() => void reconnecter()}
                            >
                              Reconnecter
                            </button>
                          )}
                        {b.etat === 'echec' && b.seq === echecOuvert && reconnexion && (
                          <span
                            className={
                              reconnexion === 'en-cours' || reconnexion === 'ok'
                                ? 'texte-faible'
                                : 'message-erreur'
                            }
                            role="status"
                            data-node={`${bn}.reconnexion`}
                          >
                            {reconnexion === 'en-cours'
                              ? 'Reconnexion…'
                              : reconnexion === 'ok'
                                ? 'Agent relancé sur le serveur'
                                : reconnexion}
                          </span>
                        )}
                      </p>
                    );
                  case 'turn_end':
                    return (
                      <p className="texte-discret" key={bn} data-node={bn}>
                        {tourInterrompu(b.error)
                          ? 'Tour interrompu'
                          : `Tour en erreur : ${b.error}`}
                      </p>
                    );
                  case 'exit':
                    // sans message : relance transparente au prochain envoi, rien à montrer (A.6)
                    return b.message ? (
                      <p className="texte-faible" key={bn} data-node={bn}>
                        Session interrompue : {b.message}. Elle reprendra au prochain message.
                      </p>
                    ) : null;
                }
              })}
            </div>
          ))}
          {agent.status === 'working' && (
            <p className="texte-faible" data-node={`${dn}.travail`}>
              {agent.kind} travaille…
            </p>
          )}
        </div>
        {pill && (
          <button
            className="bouton conversation-pilule"
            data-node={`${dn}.nouveau`}
            type="button"
            onClick={allerEnBas}
          >
            Nouveau message ↓
          </button>
        )}
        <MarkRail
          questions={questions}
          active={active}
          onSelect={scrollToQuestion}
          dataNode={`${dn}.rail`}
        />
        {menuOpen && (
          <MarkMenu
            questions={questions}
            active={active}
            onSelect={(seq) => {
              scrollToQuestion(seq);
              setMenuOpen(false);
            }}
            onClose={closeMenu}
            triggerRef={menuBtnRef}
            dataNode={`${dn}.menu`}
          />
        )}
      </div>
      {markErreur && (
        <p className="message-erreur" role="status" data-node={`${dn}.mark-erreur`}>
          {markErreur}
        </p>
      )}
      {distant?.injoignable && (
        <div className="bandeau-injoignable" role="alert" data-node={`${dn}.injoignable`}>
          <span>
            {distant.serveur} ne répond pas{distant.raison ? ` : ${distant.raison}` : ''}. Les
            messages pourront partir quand il sera de nouveau joignable.
          </span>
          {distant.onReconnecter && (
            <button
              className="bouton"
              data-node={`${dn}.injoignable.reconnecter`}
              type="button"
              onClick={() => void distant.onReconnecter?.()}
            >
              Reconnecter
            </button>
          )}
        </div>
      )}
      <Composer
        agentId={agent.id}
        kind={agent.kind}
        status={agent.status}
        settings={settingsOf(agent)}
        dataNode={`${dn}.composer`}
      />
    </div>
  );
}
