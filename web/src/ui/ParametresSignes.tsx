import {
  CLASSE_ACTION,
  validerParamsAction,
  type ActionConfirmee,
  type CorpsDemandeV2,
  type ParametresActions,
} from '../../../src/shared/confirmations.js';

function champs(params: object, prefixe = ''): string[] {
  return Object.entries(params).flatMap(([cle, valeur]) => {
    const nom = prefixe + cle;
    return valeur !== null && typeof valeur === 'object'
      ? champs(valeur, `${nom} — `)
      : [`${nom} : ${valeur === null ? 'aucun' : String(valeur)}`];
  });
}

function lisibles(action: string, params: unknown): boolean {
  try {
    if (
      !Object.hasOwn(CLASSE_ACTION, action) ||
      !validerParamsAction(action as ActionConfirmee, params)
    )
      return false;
    if (action === 'mesh.avis') {
      const sieges = (params as ParametresActions['mesh.avis']).params.sieges;
      if (
        !sieges.every(
          (s) =>
            s &&
            typeof s.peer === 'string' &&
            typeof s.family === 'string' &&
            ['chair', 'baseline', 'seat'].includes(s.role),
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function ParametresSignes({
  action,
  params,
  surface,
}: {
  action: string;
  params: unknown;
  surface: 'mac' | 'telephone';
}) {
  if (params === null) return <p>aucun paramètre</p>;
  if (!lisibles(action, params)) return <p>illisible</p>;
  const d = { action, params } as CorpsDemandeV2;
  let lignes: string[] = [];
  let texteMotion: string | undefined;
  switch (d.action) {
    case 'mesh.avis':
    case 'mesh.avis.motion': {
      const p = d.params.params;
      const roles = { chair: 'président', baseline: 'baseline', seat: 'siège' };
      lignes =
        d.action === 'mesh.avis'
          ? [
              `Salle : ${d.params.params.nom}`,
              `Carte : ${d.params.params.carte}`,
              ...d.params.params.sieges.map((s) => `${s.peer} — ${roles[s.role]} — ${s.family}`),
            ]
          : [`Canal : ${d.params.params.canal}`];
      lignes.push(
        ...(['positions', 'rebuttal', 'vote'] as const).map(
          (tour) => `Échéance ${tour} : ${new Date(p.echeances[tour]).toLocaleString('fr-FR')}`,
        ),
      );
      texteMotion = p.texte;
      break;
    }
    case 'mesh.avis.baseline-absent':
      lignes = [
        `Canal : ${d.params.params.canal}`,
        `Motion : ${d.params.params.motion}`,
        `Raison : ${d.params.params.raison}`,
      ];
      break;
    case 'merge':
      lignes = [
        `Dépôt : ${d.params.depot}`,
        `PR : ${d.params.pr}`,
        `Tête : ${d.params.tete.slice(0, 7)}`,
        `Stratégie : ${d.params.strategie}`,
        `Branche supprimée : ${d.params.supprimerBranche ? 'oui' : 'non'}`,
        `Nettoyage ensuite : ${d.params.nettoyer ? 'oui' : 'non'}`,
      ];
      break;
    case 'push':
      lignes = [
        `Branche : ${d.params.branche}`,
        `Tête : ${d.params.tete.slice(0, 7)}`,
        `Distante : ${d.params.distante?.slice(0, 7) ?? 'nouvelle branche'}`,
      ];
      break;
    case 'nettoyage':
      lignes = [
        `Branche : ${d.params.branche}`,
        `Tête : ${d.params.tete?.slice(0, 7) ?? 'sans branche'}`,
        ...(d.params.nonFusionnes
          ? [`Commits non fusionnés perdus : ${d.params.nonFusionnes}`]
          : []),
        `Modifications locales : ${d.params.sale === 'stash' ? 'mises de côté' : d.params.sale === 'force' ? 'perdues' : 'refusées'}`,
      ];
      break;
    case 'projet.retirer':
      lignes = [
        `Racine : ${surface === 'mac' ? d.params.racine : (d.params.racine.replace(/\/+$/, '').split('/').at(-1) ?? '')}`,
      ];
      break;
    case 'appairage':
      lignes = [
        `Nom : ${d.params.nom}`,
        ...(d.params.sansIdentite ? ['Sans identité Tailscale'] : []),
      ];
      break;
    case 'pda.activer':
      lignes = [`Nom : ${d.params.nom}`, `Empreinte : ${d.params.empreinte}`];
      break;
    case 'mesh.ecrire':
    case 'mesh.etat':
      lignes = [`Action : ${d.params.action}`, ...champs(d.params.params)];
      break;
    case 'host.option':
      lignes = [`Option : ${d.params.option}`, `Actif : ${d.params.actif ? 'oui' : 'non'}`];
      break;
    case 'reglage':
      lignes = [`Action : ${d.params.action}`, `Actif : ${d.params.actif ? 'oui' : 'non'}`];
      break;
    case 'essai':
      lignes = ['aucun paramètre'];
      break;
    case 'desarmement':
      lignes = ['Les actions ne demanderont plus de confirmation'];
      break;
  }
  return (
    <>
      {lignes.map((ligne) => (
        <p key={ligne}>{ligne}</p>
      ))}
      {texteMotion !== undefined && (
        <>
          <p>Texte de la motion :</p>
          <div style={{ whiteSpace: 'pre-wrap' }}>{texteMotion}</div>
        </>
      )}
    </>
  );
}
