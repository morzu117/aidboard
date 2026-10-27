import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { PiedPause } from './PiedPause.js';
import { PtySocket, type PtyExit } from './ptySocket.js';

declare global {
  interface Window {
    __aidTerminals?: Record<string, XTerm>;
  }
}

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Une instance par agent, montée une fois et masquée au changement d'onglet : la démonter rejouerait l'instantané.
export function Terminal({ agentId, visible }: { agentId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);
  const [owner, setOwner] = useState(false);
  const [size, setSize] = useState({ cols: 120, rows: 32 });
  const [approx, setApprox] = useState(false);
  const [exit, setExit] = useState<PtyExit | null>(null);
  const ownerRef = useRef(false);
  const visibleRef = useRef(visible);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: css('--surface-term', '#0a0c0f'), foreground: css('--text', '#e6e8eb') },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    if (localStorage.getItem('aid-e2e') === '1') (window.__aidTerminals ??= {})[agentId] = term;

    // Seul le propriétaire impose sa taille : fit() sur un conteneur masqué donnerait 0 × 0 et tuerait certains TUI.
    const fitAndSend = () => {
      const el = host.current;
      if (
        !ownerRef.current ||
        !visibleRef.current ||
        !el ||
        el.clientWidth < 10 ||
        el.clientHeight < 10
      )
        return;
      fit.fit();
      sock.resize(term.cols, term.rows);
      setSize({ cols: term.cols, rows: term.rows });
    };
    fitRef.current = { fit: fitAndSend };

    const sock = new PtySocket(agentId, {
      onHello: (h) => {
        term.reset();
        setApprox(h.replay === 'log');
        ownerRef.current = h.owner;
        setOwner(h.owner);
        // la taille annoncée d'abord : fitAndSend() la remplace par celle mesurée, et non l'inverse
        setSize({ cols: h.cols, rows: h.rows });
        if (h.owner) fitAndSend();
        else term.resize(h.cols, h.rows);
      },
      onOutput: (bytes) => term.write(bytes),
      onSize: (cols, rows) => {
        if (!ownerRef.current) term.resize(cols, rows);
        setSize({ cols, rows });
      },
      onOwner: (o) => {
        ownerRef.current = o;
        setOwner(o);
        if (o) fitAndSend();
      },
      onExit: setExit,
    });

    term.onData((d) => sock.input(d));
    // La main se prend sur une action de l'humain (focus, frappe, collage), jamais sur la saisie générée par xterm.
    const claim = () => !ownerRef.current && sock.claim();
    const el = host.current!;
    for (const ev of ['focusin', 'keydown', 'paste', 'pointerdown']) el.addEventListener(ev, claim);
    const observer = new ResizeObserver(fitAndSend);
    observer.observe(el);
    return () => {
      for (const ev of ['focusin', 'keydown', 'paste', 'pointerdown'])
        el.removeEventListener(ev, claim);
      observer.disconnect();
      sock.close();
      term.dispose();
      if (window.__aidTerminals) delete window.__aidTerminals[agentId];
    };
  }, [agentId]);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) fitRef.current?.fit();
  }, [visible]);

  return (
    <div className={visible ? undefined : 'masque'}>
      {approx && (
        <p className="texte-faible" data-node="1-3.terminaux.approximatif">
          Historique reconstruit depuis le journal, rendu approximatif.
        </p>
      )}
      <div
        className="sortie sortie-xterm"
        ref={host}
        data-node="1-3.terminaux.sortie"
        data-action="terminal.saisir"
        role="log"
      />
      {exit && (
        <p className="texte-faible" data-node="1-3.terminaux.sortie-fin">
          Processus terminé (
          {exit.exitCode === null ? `signal ${exit.signal ?? '?'}` : `code ${exit.exitCode}`}).
        </p>
      )}
      <div className="pied-terminal" data-node="1-3.terminaux.pied">
        <span data-node="1-3.terminaux.pied.persistance">session conservée par le daemon</span>
        <span className="taille" data-node="1-3.terminaux.pied.taille" data-bind="pty.taille">
          {size.cols}×{size.rows}
          {owner ? '' : ' · fixé par une autre vue'}
        </span>
        <PiedPause agentId={agentId} />
      </div>
    </div>
  );
}
