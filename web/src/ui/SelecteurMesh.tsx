import { type ReactNode, useEffect, useState } from 'react';
import { oublierLecturesBoard } from '../data/board.js';
import { oublierLecturesSwarph } from '../data/swarph.js';
import { MeshLecture } from '../data/meshLecture.js';
import { useMeshes } from '../data/meshes.js';
import { useAidClient } from '../data/useAidState.js';

export function EcranMesh({
  ecran,
  children,
  onChanger,
  initial,
}: {
  ecran: string;
  children: ReactNode;
  onChanger?: (mesh: string) => void;
  initial?: string;
}) {
  const client = useAidClient();
  const { meshes, multiple, relire, charge } = useMeshes();
  const [garde, setGarde] = useState<string | null>(() => {
    try {
      return initial ?? localStorage.getItem(`aid.mesh.${ecran}`);
    } catch {
      return initial ?? null;
    }
  });
  const [origine, setOrigine] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [cibleVide, setCibleVide] = useState(false);
  const [archivage, setArchivage] = useState<string | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const actifs = meshes.filter((m) => m.actif);
  const mesh =
    garde === null && actifs.length === 1
      ? actifs[0]!.nom
      : actifs.some((m) => m.nom === garde)
        ? garde!
        : 'principal';
  const disponible = meshes.length === 0 || actifs.some((m) => m.nom === mesh);
  if (
    meshes.length > 0 &&
    garde !== null &&
    garde !== 'principal' &&
    !actifs.some((m) => m.nom === garde)
  )
    setGarde('principal');
  if (initial !== origine) {
    setOrigine(initial);
    if (initial !== undefined) setGarde(initial);
  }
  useEffect(() => {
    if (!meshes.some((m) => m.actif && m.nom === mesh)) return;
    try {
      localStorage.setItem(`aid.mesh.${ecran}`, mesh);
    } catch {
      // La sélection reste locale à l'écran même si le stockage est refusé.
    }
  }, [ecran, mesh, meshes]);
  function choisir(nom: string) {
    if (nom === mesh || !meshes.some((m) => m.nom === nom && m.actif)) return;
    if (ecran === '/board/cartes') setCibleVide(true);
    setGarde(nom);
    onChanger?.(nom);
  }
  async function archiver() {
    if (!archivage || attente) return;
    setAttente(true);
    setErreur('');
    try {
      await client.request('POST', `/api/meshes/${encodeURIComponent(archivage)}/archiver`);
      oublierLecturesBoard(client);
      oublierLecturesSwarph(client);
      setRevision((r) => r + 1);
      await client.refresh();
      await relire();
      setArchivage(null);
    } catch {
      setErreur('Archivage impossible. Réessaie.');
    } finally {
      setAttente(false);
    }
  }
  const contenu = (
    <>
      {multiple && (
        <div className="groupe-filtres" style={{ margin: 'var(--sp-4) var(--sp-8) 0' }}>
          <label>
            Mesh{' '}
            <select aria-label="Mesh" value={mesh} onChange={(e) => choisir(e.target.value)}>
              {meshes.map((m) => (
                <option key={m.nom} value={m.nom} disabled={!m.actif}>
                  {m.nom}
                  {!m.actif ? ` — ${m.erreur ?? 'inactif'}` : ''}
                </option>
              ))}
            </select>
          </label>
          {meshes
            .filter((m) => m.erreur === 'rebranche')
            .map((m) => (
              <button key={m.nom} onClick={() => setArchivage(m.nom)}>
                Archiver les anciennes données — {m.nom}
              </button>
            ))}
          {archivage && (
            <div role="alertdialog" aria-label="Confirmer l’archivage">
              <p>
                Archiver les anciennes données de {archivage} ? Elles resteront en lecture seule.
              </p>
              <button disabled={attente} onClick={() => void archiver()}>
                Confirmer l’archivage
              </button>
              <button disabled={attente} onClick={() => setArchivage(null)}>
                Annuler
              </button>
            </div>
          )}
          {erreur && <p role="alert">{erreur}</p>}
        </div>
      )}
      <MeshLecture.Provider key={`${mesh}:${revision}`} value={mesh}>
        {!cibleVide &&
          disponible &&
          (garde === null || garde === 'principal' || charge) &&
          children}
      </MeshLecture.Provider>
    </>
  );
  return (
    <MeshLecture.Provider value={mesh}>
      {multiple ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
          }}
        >
          {contenu}
        </div>
      ) : (
        contenu
      )}
    </MeshLecture.Provider>
  );
}

export function EnteteMesh({ mesh }: { mesh: string }) {
  const { multiple } = useMeshes();
  return multiple ? (
    <p>
      <strong>Mesh : {mesh}</strong>
    </p>
  ) : null;
}
