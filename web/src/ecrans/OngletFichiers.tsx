import { useEffect, useState } from 'react';
import type { FileNode, FilesResponse } from '../../../src/shared/files.js';
import { AidApiError } from '../data/api.js';
import { fetchFileContent, fetchFileTree } from '../data/files.js';
import { useAid } from '../data/useAidState.js';
import { renderMarkdown } from '../ui/markdown.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function filterTree(nodes: FileNode[], pred: (n: FileNode) => boolean): FileNode[] {
  const kept: FileNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (pred(n)) kept.push(n);
    } else {
      const entries = filterTree(n.entries ?? [], pred);
      if (entries.length > 0 || pred(n)) kept.push({ ...n, entries });
    }
  }
  return kept;
}

function Noeud({
  node,
  depth,
  expanded,
  forceOpen,
  selected,
  onToggleDir,
  onOpenFile,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  forceOpen: boolean;
  selected: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const style = { paddingLeft: `calc(var(--sp-2) + ${depth} * var(--sp-5))` };
  if (node.kind === 'dir') {
    const isOpen = forceOpen || expanded.has(node.path);
    return (
      <>
        <button
          type="button"
          className="fichier fichier--dossier"
          style={style}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isOpen}
          aria-selected="false"
          title={node.path}
          data-action="fichiers.basculer"
          data-chemin={node.path}
          onClick={() => onToggleDir(node.path)}
        >
          <span className="chevron" aria-hidden="true">
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="fichier-chemin">{node.name}</span>
          <span className="fichier-etat fichier-etat--dossier">
            {node.status === '•' ? '•' : ''}
          </span>
        </button>
        {isOpen &&
          (node.entries ?? []).map((e) => (
            <Noeud
              key={e.path}
              node={e}
              depth={depth + 1}
              expanded={expanded}
              forceOpen={forceOpen}
              selected={selected}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
      </>
    );
  }
  return (
    <button
      type="button"
      className={`fichier${selected === node.path ? ' est-actif' : ''}`}
      style={style}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected === node.path}
      title={node.path}
      data-action="fichiers.ouvrir"
      data-chemin={node.path}
      onClick={() => onOpenFile(node.path)}
    >
      <span className="fichier-chemin">{node.name}</span>
      {node.status && (
        <span className={`fichier-etat fichier-etat--${node.status.toLowerCase()}`}>
          {node.status}
        </span>
      )}
    </button>
  );
}

// 11.8/11.9 (écrans 3.4/3.5) : explorateur (arbre + statut git, D29) et visionneuse Markdown
// (D30). `editeur.ouvrir-fichier` est câblé mais son backend n'arrive qu'au point 11.11 :
// jusque-là le bouton répond « action inconnue », comme prévu par le séquencement du plan.
// `fichier.reveler` (révéler dans le Finder/Explorer) n'a aucun contrat backend nulle part
// dans ce chantier (ni 11.7 ni 11.11) : omis plutôt que fabriqué, à la différence de
// « mentionner à l'agent » qui réutilise POST /api/agents/:id/input, déjà existant.
export function OngletFichiers({
  topicId,
  activeAgentId,
}: {
  topicId: string;
  activeAgentId: string | null;
}) {
  const { call } = useAid();
  const [scope, setScope] = useState<'tout' | 'modifies'>('tout');
  const [filtre, setFiltre] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tree, setTree] = useState<FilesResponse | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [mentionErreur, setMentionErreur] = useState<string | null>(null);
  const [editeurErreur, setEditeurErreur] = useState<string | null>(null);
  // D31 : la bascule aperçu/source ne vaut que pour un .md ; tout autre fichier est
  // toujours en source, quel que soit `mode` (voir `modeEffectif`).
  const [mode, setMode] = useState<'apercu' | 'source'>('apercu');

  function charger() {
    fetchFileTree(call, topicId, scope).then(
      (r) => {
        setTree(r);
        setTreeError(null);
      },
      (err: unknown) => setTreeError(err instanceof AidApiError ? err.message : String(err)),
    );
  }

  useEffect(() => {
    charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, topicId, scope]);

  function ouvrirFichier(path: string) {
    setSelected(path);
    setContent(null);
    setContentError(null);
    setContentLoading(true);
    setMentionErreur(null);
    setEditeurErreur(null);
    setMode('apercu');
    fetchFileContent(call, topicId, path).then(
      (r) => {
        setContent(r.content);
        setContentLoading(false);
      },
      (err: unknown) => {
        setContentError(err instanceof AidApiError ? err.message : String(err));
        setContentLoading(false);
      },
    );
  }

  function basculerDossier(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function copierChemin() {
    if (selected) await navigator.clipboard.writeText(selected);
  }

  async function mentionnerAgent() {
    if (!selected || !activeAgentId) return;
    setMentionErreur(null);
    try {
      await call('POST', `/api/agents/${activeAgentId}/input`, { text: `@${selected} ` });
    } catch (err) {
      setMentionErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  async function ouvrirDansEditeur() {
    if (!selected) return;
    setEditeurErreur(null);
    try {
      await call('POST', `/api/topics/${topicId}/actions/editeur.ouvrir-fichier`, {
        path: selected,
      });
    } catch (err) {
      setEditeurErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  const mots = fold(filtre).split(/\s+/).filter(Boolean);
  const filtering = mots.length > 0;
  const racine = tree
    ? filtering
      ? filterTree(tree.tree, (n) => mots.every((m) => fold(n.name).includes(m)))
      : tree.tree
    : [];
  const segments = selected ? selected.split('/') : [];
  const estMarkdown = selected?.toLowerCase().endsWith('.md') ?? false;
  const modeEffectif = estMarkdown ? mode : 'source';
  const rendu =
    content !== null && estMarkdown && modeEffectif === 'apercu' ? renderMarkdown(content) : null;
  const estVide = content === '';
  const lignes =
    content !== null ? (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n') : [];

  return (
    <div className="sujet-grille" data-node="3-4">
      <div className="colonne">
        <section className="panneau" data-node="3-4.explorateur" aria-label="Explorateur">
          <div className="outils">
            <input
              className="champ"
              type="text"
              placeholder="Filtrer les fichiers"
              aria-label="Filtrer les fichiers"
              value={filtre}
              onChange={(e) => setFiltre(e.target.value)}
              data-action="fichiers.filtrer"
            />
            <button
              className={`portee${scope === 'tout' ? ' est-actif' : ''}`}
              type="button"
              data-action="fichiers.portee"
              data-valeur="tout"
              aria-pressed={scope === 'tout'}
              onClick={() => setScope('tout')}
            >
              Tout
            </button>
            <button
              className={`portee${scope === 'modifies' ? ' est-actif' : ''}`}
              type="button"
              data-action="fichiers.portee"
              data-valeur="modifies"
              aria-pressed={scope === 'modifies'}
              onClick={() => setScope('modifies')}
            >
              Modifiés{tree ? ` · ${tree.modified}` : ''}
            </button>
            <button
              className="bouton-icone"
              type="button"
              data-action="fichiers.replier"
              aria-label="Tout replier"
              onClick={() => setExpanded(new Set())}
            >
              ▾
            </button>
            <button
              className="bouton-icone"
              type="button"
              data-action="fichiers.rafraichir"
              aria-label="Rafraîchir"
              onClick={charger}
            >
              ↻
            </button>
          </div>
          {treeError && (
            <p className="message-erreur" role="alert">
              {treeError}
            </p>
          )}
          {tree && (
            <p className="texte-faible" data-node="3-4.explorateur.compteur">
              {tree.total} fichier{tree.total === 1 ? '' : 's'} · {tree.modified} modifié
              {tree.modified === 1 ? '' : 's'}
              {tree.truncated ? ' (liste tronquée)' : ''}
            </p>
          )}
          {tree && racine.length === 0 && (
            <p className="vide-arbre">
              {scope === 'modifies'
                ? 'Aucun fichier modifié.'
                : 'Aucun fichier ne correspond au filtre.'}
            </p>
          )}
          {tree && racine.length > 0 && (
            <div className="arbre" role="tree" aria-label="Fichiers du worktree">
              {racine.map((n) => (
                <Noeud
                  key={n.path}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  forceOpen={filtering}
                  selected={selected}
                  onToggleDir={basculerDossier}
                  onOpenFile={ouvrirFichier}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="colonne">
        <aside className="panneau" data-node="3-4.visionneuse" aria-label="Visionneuse">
          {!selected && <p className="texte-discret">Choisis un fichier dans l’explorateur.</p>}
          {selected && (
            <>
              <div className="visionneuse-entete">
                <div className="visionneuse-meta">
                  <nav
                    className="fil-ariane"
                    aria-label="Chemin du fichier"
                    data-node="3-4.visionneuse.chemin"
                  >
                    {segments.join(' / ')}
                  </nav>
                </div>
                {estMarkdown && (
                  <div className="segmente" role="group" aria-label="Mode d’affichage">
                    <button
                      type="button"
                      className={`segment${mode === 'apercu' ? ' est-actif' : ''}`}
                      data-action="visionneuse.mode"
                      data-valeur="apercu"
                      aria-pressed={mode === 'apercu'}
                      onClick={() => setMode('apercu')}
                    >
                      Aperçu
                    </button>
                    <button
                      type="button"
                      className={`segment${mode === 'source' ? ' est-actif' : ''}`}
                      data-action="visionneuse.mode"
                      data-valeur="source"
                      aria-pressed={mode === 'source'}
                      onClick={() => setMode('source')}
                    >
                      Source
                    </button>
                  </div>
                )}
                <div className="actions">
                  <button
                    className="bouton"
                    type="button"
                    data-action="fichier.copier-chemin"
                    onClick={() => void copierChemin()}
                  >
                    Copier le chemin
                  </button>
                  <button
                    className="bouton"
                    type="button"
                    data-action="agent.mentionner-fichier"
                    disabled={!activeAgentId}
                    title={
                      activeAgentId
                        ? `Insère @${selected} dans le terminal`
                        : 'Aucun agent actif à mentionner'
                    }
                    onClick={() => void mentionnerAgent()}
                  >
                    Mentionner à l’agent
                  </button>
                  <button
                    className="bouton"
                    type="button"
                    data-action="editeur.ouvrir-fichier"
                    onClick={() => void ouvrirDansEditeur()}
                  >
                    Ouvrir dans l’éditeur
                  </button>
                </div>
              </div>
              {mentionErreur && (
                <p className="message-erreur" role="alert">
                  {mentionErreur}
                </p>
              )}
              {editeurErreur && (
                <p className="message-erreur" role="alert">
                  {editeurErreur}
                </p>
              )}
              {contentLoading && <p className="texte-discret">Chargement…</p>}
              {contentError && (
                <p className="message-erreur" role="alert">
                  {contentError}
                </p>
              )}
              {content !== null && estVide && (
                <section className="vide" data-node="3-4.visionneuse.vide">
                  <p className="vide-message">Fichier vide.</p>
                  <p className="texte-discret">{selected} existe mais ne contient encore rien.</p>
                </section>
              )}
              {content !== null && !estVide && modeEffectif === 'apercu' && rendu && (
                <div className="lecture">
                  <article className="document" data-node="3-4.visionneuse.document">
                    {rendu.body}
                  </article>
                  {rendu.headings.length > 0 && (
                    <nav className="sommaire" aria-label="Sommaire">
                      <span className="titre-zone">Sommaire</span>
                      {rendu.headings.map((h) => (
                        <a key={h.id} className="sommaire-lien" href={`#${h.id}`}>
                          {h.text}
                        </a>
                      ))}
                    </nav>
                  )}
                </div>
              )}
              {content !== null && !estVide && modeEffectif === 'source' && (
                <div
                  className="source"
                  data-node="3-4.visionneuse.source"
                  role="region"
                  aria-label="Source du fichier"
                >
                  {lignes.map((ligne, i) => (
                    <div key={i} className="source-ligne">
                      <span className="source-numero" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="source-texte">{ligne}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
