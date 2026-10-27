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
import type { Agent, AgentStatus } from '../../../src/shared/model.js';
import type { AgentStreamItem } from '../../../src/shared/conversation.js';
import { useAid } from '../data/useAidState.js';
import { AgentSocket } from './agentSocket.js';
import { Composer } from './Composer.js';
import { DecisionCard } from './DecisionCard.js';
import { MarkMenu } from './MarkMenu.js';
import { MarkRail, type QuestionRepere } from './MarkRail.js';
import { Message } from './Message.js';
import { ToolCallGroup } from './ToolCallGroup.js';
import { buildTurns, tourInterrompu } from './thread.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const SEUIL_BAS = 40;
const SEUIL_REPERE = 40;
// Le canal précédent a fermé (D65) ; ces statuts disent que l'agent est reparti sous le même id (A.6).
const REPART: ReadonlySet<AgentStatus> = new Set(['starting', 'working', 'needs_input']);

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
  // id stable mais unique par instance (D65 : une Conversation par agent, montée en permanence) —
  // `dn` est une constante littérale partagée par toutes les instances, donc impropre à un id DOM (review A.7)
  const raccourcisId = useId();

  const ouvrirSocket = useCallback(
    () =>
      new AgentSocket(agent.id, {
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
        },
        onExit: () => {
          exitedRef.current = true;
        },
        onLink: setLinked,
      }),
    [agent.id],
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
  const toggleMark = async (seq: number, marked: boolean) => {
    try {
      await call('PUT', `/api/agents/${agent.id}/messages/${seq}/mark`, { marked });
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
                    return (
                      <DecisionCard
                        key={bn}
                        agentId={agent.id}
                        request={b.request}
                        resolved={agent.pending?.id !== b.request.id}
                        dataNode={bn}
                      />
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
      <Composer
        agentId={agent.id}
        kind={agent.kind}
        status={agent.status}
        dataNode={`${dn}.composer`}
      />
    </div>
  );
}
