import { useEffect, useState } from 'react';
import type { Workspace, WorkspaceConsignes } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { Layout, useLayout } from '../ui/Layout.js';

function Fichier({ id, nom, present }: { id: string; nom: string; present: boolean }) {
  return (
    <span className={`pastille ${present ? 'pastille--code' : 'pastille--discret'}`} data-node={id}>
      {nom} {present ? 'présent' : 'absent'}
    </span>
  );
}

function Projet({ n, w }: { n: number; w: Workspace }) {
  const { call } = useAid();
  const [c, setC] = useState<WorkspaceConsignes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    call<WorkspaceConsignes>('GET', `/api/workspaces/${w.id}/consignes`).then(setC, (err) =>
      setErreur(err instanceof Error ? err.message : String(err)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.id]);
  const id = `consignes.projet-${n}`;
  const retard = c?.blockVersion && c.kernelVersion && c.blockVersion !== c.kernelVersion;
  return (
    <article className="element" data-node={id} aria-label={w.name}>
      <div className="element-entete">
        <span className="identifiant" data-node={`${id}.nom`}>
          {w.name}
        </span>
        <span className="element-sujet">{w.root}</span>
      </div>
      {erreur && (
        <p className="message-erreur" role="alert">
          {erreur}
        </p>
      )}
      {c && (
        <>
          <div className="element-actions">
            <Fichier id={`${id}.claude-md`} nom="CLAUDE.md" present={c.claudeMd} />
            <Fichier id={`${id}.agents-md`} nom="AGENTS.md" present={c.agentsMd} />
          </div>
          <p className="element-detail" data-node={`${id}.bloc`}>
            {c.blockVersion
              ? `Bloc agentkit ${c.blockVersion}`
              : 'Pas de bloc agentkit dans ces fichiers'}
            {c.kernelVersion ? ` · noyau installé ${c.kernelVersion}` : ' · aucun noyau installé'}
          </p>
          {retard && (
            <p className="message-info" data-node={`${id}.retard`}>
              Le bloc a été rendu depuis une autre version du noyau : lance /sync dans ce projet
              pour le mettre à jour.
            </p>
          )}
        </>
      )}
    </article>
  );
}

function Contenu() {
  const { state } = useAid();
  const { openNewWorkspace } = useLayout();
  const workspaces = state?.workspaces ?? [];
  return (
    <main className="page">
      <div className="entete" data-node="consignes.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="consignes.entete.titre">
            Consignes
          </h1>
          <p className="resume">
            Les consignes que lisent les agents de chaque projet. En lecture seule : A-I-D ne
            modifie jamais ces fichiers.
          </p>
        </div>
      </div>
      {state && workspaces.length === 0 ? (
        <section className="vide" data-node="consignes.vide">
          <p className="vide-message">Aucun projet : ajoutes-en un pour voir ses consignes.</p>
          <div className="vide-actions">
            <button className="bouton bouton--primaire" type="button" onClick={openNewWorkspace}>
              Ajouter un projet
            </button>
          </div>
        </section>
      ) : (
        <div className="groupe" data-node="consignes.liste">
          {workspaces.map((w, i) => (
            <Projet key={w.id} n={i + 1} w={w} />
          ))}
        </div>
      )}
    </main>
  );
}

export function Consignes() {
  return (
    <Layout screen="consignes">
      <Contenu />
    </Layout>
  );
}
