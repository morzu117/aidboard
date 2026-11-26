type Version = [bigint, bigint, bigint];
type Borne = (version: Version) => boolean;

function composantes(texte: string): Version {
  const [majeure = '0', mineure = '0', correctif = '0'] = texte.split('.');
  return [BigInt(majeure), BigInt(mineure), BigInt(correctif)];
}

function comparer(a: Version, b: Version): number {
  for (const i of [0, 1, 2] as const) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function lireBorne(texte: string): Borne {
  const match = /^(>=|<=|[><=^~])?(\d+(?:\.\d+){0,2})$/.exec(texte);
  const [, operateur, numero] = match ?? [];
  if (numero === undefined) throw new Error(`borne de version invalide : ${texte}`);
  const longueur = numero.split('.').length;
  const limite = composantes(numero);
  const [majeure, mineure, correctif] = limite;
  switch (operateur) {
    case '>=':
      return (v) => comparer(v, limite) >= 0;
    case '>':
      return (v) => comparer(v, limite) > 0;
    case '<=':
      return (v) => comparer(v, limite) <= 0;
    case '<':
      return (v) => comparer(v, limite) < 0;
    case '=':
      return (v) => comparer(v, limite) === 0;
    case '^':
    case '~': {
      if (longueur !== 3) throw new Error(`borne de version invalide : ${texte}`);
      let plafond: Version;
      if (operateur === '~') plafond = [majeure, mineure + 1n, 0n];
      else if (majeure !== 0n) plafond = [majeure + 1n, 0n, 0n];
      else if (mineure !== 0n) plafond = [0n, mineure + 1n, 0n];
      else plafond = [0n, 0n, correctif + 1n];
      return (v) => comparer(v, limite) >= 0 && comparer(v, plafond) < 0;
    }
    default:
      return (v) => limite.slice(0, longueur).every((partie, i) => v[i] === partie);
  }
}

/** Compile toutes les branches pour signaler les erreurs avant tout appel à un outil. */
export function lirePlageVersion(plage: string): (version: string) => boolean {
  const branches = plage.split('||').map((branche) => branche.trim().split(/\s+/).map(lireBorne));
  return (version) => {
    const numero = composantes(version);
    return branches.some((bornes) => bornes.every((borne) => borne(numero)));
  };
}

export function extraireVersion(stdout: string, stderr: string): string | undefined {
  const motif = /\d+\.\d+(?:\.\d+)?/;
  return motif.exec(stdout)?.[0] ?? motif.exec(stderr)?.[0];
}
