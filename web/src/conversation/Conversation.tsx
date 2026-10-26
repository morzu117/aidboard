import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentStatus } from '../../../src/shared/model.js';
import type { AgentStreamItem } from '../../../src/shared/conversation.js';
import { AgentSocket } from './agentSocket.js';
import { Composer } from './Composer.js';
import { DecisionCard } from './DecisionCard.js';
import { Message } from './Message.js';
import { ToolCallGroup } from './ToolCallGroup.js';
import { buildTurns, tourInterrompu } from './thread.js';

const SEUIL_BAS = 40;
// Le canal précédent a fermé (D65) ; ces statuts disent que l'agent est reparti sous le même id (A.6).
const REPART: ReadonlySet<AgentStatus> = new Set(['starting', 'working', 'needs_input']);

// Une instance par agent, montée une fois et masquée au changement d'onglet, comme <Terminal> (D65).
export function Conversation({ agent, visible }: { agent: Agent; visible: boolean }) {
  const [items, setItems] = useState<Map<number, AgentStreamItem>>(new Map());
  const [truncated, setTruncated] = useState(false);
  const [linked, setLinked] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [pill, setPill] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const sockRef = useRef<AgentSocket | null>(null);
  // pas de rendu propre (A.6) : seul un futur changement de `agent.status` doit déclencher la relance
  const exitedRef = useRef(false);

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
  };

  const allerEnBas = () => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setPill(false);
  };

  const dn = '1-3.conversation';

  return (
    <div className={visible ? 'conversation' : 'conversation masque'} data-node={dn}>
      {truncated && (
        <p className="conversation-bandeau" data-node={`${dn}.tronque`}>
          Historique tronqué : les messages les plus anciens ne sont pas affichés.
        </p>
      )}
      <div className="conversation-barre" data-node={`${dn}.barre`}>
        {!linked && (
          <span className="texte-faible" data-node={`${dn}.reconnexion`}>
            reconnexion…
          </span>
        )}
        <div className="composer-pousser" />
        {toolSeqs.length > 0 && (
          <button className="bouton" data-node={`${dn}.tout`} type="button" onClick={toggleAll}>
            {allOpen ? 'Tout replier' : 'Tout déplier'}
          </button>
        )}
      </div>
      <div className="conversation-fil-zone">
        <div
          className="fil-conversation"
          data-node={`${dn}.fil`}
          ref={threadRef}
          tabIndex={0}
          role="log"
          aria-label="Fil de conversation"
          onScroll={onScroll}
        >
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
      </div>
      <Composer
        agentId={agent.id}
        kind={agent.kind}
        status={agent.status}
        dataNode={`${dn}.composer`}
      />
    </div>
  );
}
