import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useRef, useState } from 'react';
import type { AgentSettings } from '../../../src/shared/agentSettings.js';
import type { AgentCommand, AgentOptions } from '../../../src/shared/agentSettings.js';
import type { AgentStatus } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { ComposerReglages } from './ComposerReglages.js';
import {
  aide,
  commandeAid,
  completer,
  filtrerCommandes,
  reglageDe,
  saisieCommande,
} from './commandes.js';
import { fetchFileTree } from '../data/files.js';
import {
  aplatir,
  filtrerFichiers,
  insererMention,
  saisieMention,
  type FichiersMention,
} from './fichiersMention.js';
import { useAgentRoutes } from './routes.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// D70 : mêmes bornes que le daemon, vérifiées ici pour refuser avant de lire le fichier.
const PIECES_MAX = 5;
const PIECE_MAX_OCTETS = 10 * 1024 * 1024;

const enBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error(`lecture impossible : ${f.name}`));
    r.readAsDataURL(f);
  });

export function Composer({
  agentId,
  kind,
  status,
  settings,
  dataNode,
  topicId,
}: {
  agentId: string;
  kind: string;
  status: AgentStatus;
  /** Agent `stream` (chantier 16) : présent, les chips mode et modèle s'affichent. */
  settings?: AgentSettings;
  dataNode: string;
  /** Chantier 26 (D118) : agent de sujet, le menu `@` liste les fichiers de son worktree. */
  topicId?: string;
}) {
  const { call } = useAid();
  const { api, distant } = useAgentRoutes();
  // R.6 (§11.3) : serveur injoignable, rien ne part ; le bandeau de l'écran Discussion dit pourquoi
  const ferme = distant?.injoignable === true;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [arretBusy, setArretBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const composingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [pieces, setPieces] = useState<File[]>([]);
  const fichierRef = useRef<HTMLInputElement>(null);
  // pièces jointes : agents `stream` seulement (D70), les mêmes qui ont des réglages
  // R.6 : pas sur un serveur distant, une pièce jointe est un fichier du daemon (D70)
  const joindre = settings !== undefined && !distant;

  const needsInput = status === 'needs_input';
  const working = status === 'working';

  // Chantier 22 (D86) : le menu des commandes `/`, pour un agent `stream` (celui qui a des réglages)
  const [commandes, setCommandes] = useState<AgentCommand[] | null>(null);
  const [choix, setChoix] = useState(0);
  const [menuFerme, setMenuFerme] = useState(false);
  const [avis, setAvis] = useState<string | null>(null);
  const requete = settings ? saisieCommande(text) : null;
  const proposees =
    requete !== null && !menuFerme && commandes ? filtrerCommandes(commandes, requete) : [];
  const menuOuvert = requete !== null && !menuFerme && commandes !== null;
  const choisie = proposees[Math.min(choix, proposees.length - 1)];
  const lireOptions = () => call<AgentOptions>('GET', `${api}/${agentId}/options`);
  // relu à chaque `/` tapé en tête : claude n'annonce ses commandes qu'à son premier tour (D83)
  const chargerCommandes = () => {
    lireOptions().then(
      (o) => setCommandes(o.commands),
      () => setCommandes((c) => c ?? []),
    );
  };

  // Chantier 26 (D118) : le menu des fichiers `@` ; une discussion de serveur n'a pas de worktree sur le Mac
  const [fichiers, setFichiers] = useState<FichiersMention | null>(null);
  const mention = topicId ? saisieMention(text) : null;
  const fichiersProposes =
    mention !== null && !menuFerme && fichiers ? filtrerFichiers(fichiers.chemins, mention) : [];
  const menuFichiers = mention !== null && !menuFerme && fichiers !== null;
  const fichierChoisi = fichiersProposes[Math.min(choix, fichiersProposes.length - 1)];
  // relu à chaque `@` tapé : le worktree change pendant que l'agent travaille
  const chargerFichiers = (id: string) => {
    fetchFileTree(call, id, 'tout').then(
      (r) => setFichiers(aplatir(r)),
      () => setFichiers((f) => f ?? { chemins: [], tronque: false }),
    );
  };
  const choisirFichier = (chemin: string) => {
    setText(insererMention(text, chemin));
    setChoix(0);
  };

  /** D81 : une commande A-I-D est exécutée ici et ne part jamais à l'agent ; `/compact` part, chaque pilote la sait. */
  const executer = async (t: string): Promise<boolean> => {
    const cmd = settings && pieces.length === 0 ? commandeAid(t) : null;
    if (!cmd || cmd.name === 'compact') return false;
    if (cmd.name === 'aide') {
      setAvis(aide(commandes ?? (await lireOptions()).commands));
    } else if (cmd.name === 'stop') {
      if (working) await call('POST', `${api}/${agentId}/interrupt`);
      setAvis(working ? 'Tour interrompu' : 'Aucun tour en cours');
    } else {
      const r = reglageDe(cmd, await lireOptions(), settings!);
      if (!r) return false;
      if ('erreur' in r) {
        setErreur(r.erreur);
        return true;
      }
      await call<AgentSettings>('PATCH', `${api}/${agentId}/settings`, r.patch);
      setAvis(r.avis);
    }
    setText('');
    return true;
  };

  const envoyer = async () => {
    const t = text.trim();
    if ((!t && pieces.length === 0) || needsInput || busy) return;
    setBusy(true);
    setErreur(null);
    setAvis(null);
    try {
      if (await executer(t)) return;
      const attachments = await Promise.all(
        pieces.map(async (f) => ({
          name: f.name,
          type: f.type || 'application/octet-stream',
          data: await enBase64(f),
        })),
      );
      await call(
        'POST',
        `${api}/${agentId}/input`,
        attachments.length > 0 ? { text, attachments } : { text },
      );
      setText('');
      setPieces([]);
      // D81 : la compaction se fait sans message de l'agent (codex) : on dit qu'elle est partie
      if (settings && attachments.length === 0 && commandeAid(t)?.name === 'compact')
        setAvis('Compaction demandée à l’agent');
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };

  const arreter = async () => {
    if (arretBusy) return;
    setArretBusy(true);
    setErreur(null);
    try {
      await call('POST', `${api}/${agentId}/interrupt`);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setArretBusy(false);
    }
  };

  const ajouter = (fichiers: File[]) => {
    if (!joindre || fichiers.length === 0) return;
    const trop = fichiers.find((f) => f.size > PIECE_MAX_OCTETS);
    if (trop) {
      setErreur(`${trop.name} dépasse 10 Mio`);
      return;
    }
    if (pieces.length + fichiers.length > PIECES_MAX) {
      setErreur(`${PIECES_MAX} pièces jointes au plus`);
      return;
    }
    setErreur(null);
    setPieces([...pieces, ...fichiers]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!joindre || images.length === 0) return;
    e.preventDefault();
    ajouter(images);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!joindre || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    ajouter(Array.from(e.dataTransfer.files));
  };

  const onInput = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // D118 : comme le menu `/` ; Tab ou Entrée insèrent le chemin
    if (menuFichiers && fichiersProposes.length > 0 && !composingRef.current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = fichiersProposes.length;
        setChoix((Math.min(choix, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      // Entrée sur un chemin déjà complet envoie, comme sur un nom de commande complet
      const insere = fichierChoisi ? insererMention(text, fichierChoisi) : text;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && insere.trim() !== text)) {
        e.preventDefault();
        setText(insere);
        setChoix(0);
        return;
      }
    }
    // D86 : ↑ ↓ choisissent, Tab ou Entrée complètent, Échap ferme ; Entrée sur un nom complet envoie
    if (menuOuvert && proposees.length > 0 && !composingRef.current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = proposees.length;
        setChoix((Math.min(choix, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      const complet = choisie ? completer(choisie) : text;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && complet.trim() !== text)) {
        e.preventDefault();
        setText(complet);
        setChoix(0);
        return;
      }
    }
    if ((menuOuvert || menuFichiers) && e.key === 'Escape') {
      e.preventDefault();
      setMenuFerme(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
      e.preventDefault();
      void envoyer();
    }
  };

  return (
    <div
      className="composer"
      data-node={dataNode}
      onDragOver={(e) => joindre && e.preventDefault()}
      onDrop={onDrop}
    >
      {pieces.length > 0 && (
        <ul
          className="composer-pieces"
          aria-label="Pièces jointes"
          data-node={`${dataNode}.pieces`}
        >
          {pieces.map((f, i) => (
            <li key={`${i}-${f.name}`} className="composer-piece">
              <span className="composer-piece-nom">{f.name}</span>
              <button
                type="button"
                className="composer-piece-retirer"
                aria-label={`Retirer ${f.name}`}
                onClick={() => setPieces(pieces.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {menuOuvert && (
        <ul
          id={`${dataNode}-commandes`}
          className="composer-commandes"
          role="listbox"
          aria-label="Commandes"
          data-node={`${dataNode}.commandes`}
        >
          {proposees.map((c) => (
            <li
              key={`${c.source}-${c.name}`}
              id={`${dataNode}-commande-${c.name}`}
              role="option"
              aria-selected={c === choisie}
              className="composer-commande"
              onMouseDown={(e) => {
                // le champ garde le focus : la complétion se fait comme au clavier
                e.preventDefault();
                setText(completer(c));
                setChoix(0);
                taRef.current?.focus();
              }}
            >
              <span className="composer-commande-nom">
                /{c.name}
                {c.args ? ` ${c.args}` : ''}
              </span>
              <span className="composer-commande-description">{c.description}</span>
              {c.source === 'aid' && <span className="composer-commande-source">A-I-D</span>}
            </li>
          ))}
          {proposees.length === 0 && (
            <li className="composer-commande-vide" data-node={`${dataNode}.commandes.vide`}>
              Aucune commande connue : le message part tel quel à {kind}.
            </li>
          )}
        </ul>
      )}
      {menuFichiers && (
        <ul
          id={`${dataNode}-mention`}
          className="composer-commandes"
          role="listbox"
          aria-label="Fichiers"
          data-node={`${dataNode}.mention`}
        >
          {fichiersProposes.map((chemin, i) => (
            <li
              key={chemin}
              id={`${dataNode}-mention-${i}`}
              role="option"
              aria-selected={chemin === fichierChoisi}
              className="composer-commande"
              onMouseDown={(e) => {
                e.preventDefault();
                choisirFichier(chemin);
                taRef.current?.focus();
              }}
            >
              <span className="composer-commande-nom">@{chemin}</span>
            </li>
          ))}
          {fichiersProposes.length === 0 && (
            <li className="composer-commande-vide" data-node={`${dataNode}.mention.vide`}>
              Aucun fichier ne correspond.
            </li>
          )}
          {fichiers.tronque && (
            <li className="composer-commande-vide" data-node={`${dataNode}.mention.tronque`}>
              Liste incomplète : le worktree est trop grand pour être lu en entier.
            </li>
          )}
        </ul>
      )}
      <textarea
        ref={taRef}
        className="composer-champ"
        data-node={`${dataNode}.champ`}
        aria-label={`Message à ${kind}`}
        placeholder={distant ? `Écris à ${kind} sur ${distant.serveur}…` : `Écris à ${kind}…`}
        rows={2}
        maxLength={4000}
        disabled={needsInput || ferme}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onInput();
          setAvis(null);
          setChoix(0);
          setMenuFerme(false);
          const v = e.target.value;
          if (settings && saisieCommande(v) !== null && (v === '/' || commandes === null))
            chargerCommandes();
          const m = topicId ? saisieMention(v) : null;
          if (topicId && m !== null && (m === '' || fichiers === null)) chargerFichiers(topicId);
        }}
        aria-controls={
          menuOuvert ? `${dataNode}-commandes` : menuFichiers ? `${dataNode}-mention` : undefined
        }
        aria-activedescendant={
          menuOuvert && choisie
            ? `${dataNode}-commande-${choisie.name}`
            : menuFichiers && fichierChoisi
              ? `${dataNode}-mention-${fichiersProposes.indexOf(fichierChoisi)}`
              : undefined
        }
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => (composingRef.current = false)}
      />
      <div className="composer-barre">
        {joindre && (
          <>
            <button
              className="composer-trombone"
              data-node={`${dataNode}.joindre`}
              type="button"
              aria-label="Joindre des fichiers"
              disabled={needsInput}
              onClick={() => fichierRef.current?.click()}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 8" />
              </svg>
            </button>
            <input
              ref={fichierRef}
              type="file"
              multiple
              hidden
              data-node={`${dataNode}.fichiers`}
              onChange={(e) => {
                ajouter(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        )}
        {settings && (
          <ComposerReglages
            agentId={agentId}
            kind={kind === 'codex' ? 'codex' : 'claude'}
            settings={settings}
            onErreur={setErreur}
            dataNode={dataNode}
          />
        )}
        {needsInput && (
          <span className="texte-discret" data-node={`${dataNode}.attente`}>
            Répondre d’abord à la demande
          </span>
        )}
        <div className="composer-pousser" />
        {working && (
          <button
            className="bouton"
            data-node={`${dataNode}.arreter`}
            type="button"
            disabled={arretBusy}
            onClick={() => void arreter()}
          >
            Interrompre
          </button>
        )}
        <button
          className="bouton-icone bouton--primaire"
          data-node={`${dataNode}.envoyer`}
          type="button"
          aria-label="Envoyer"
          disabled={(!text.trim() && pieces.length === 0) || needsInput || busy || ferme}
          onClick={() => void envoyer()}
        >
          ↑
        </button>
      </div>
      {avis && (
        <p className="composer-avis" role="status" data-node={`${dataNode}.avis`}>
          {avis}
        </p>
      )}
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </p>
      )}
    </div>
  );
}
