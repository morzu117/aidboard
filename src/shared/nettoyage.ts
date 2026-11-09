/*
Détection locale avant envoi.

Source : swarph-cli 0.72.47, scrub.py et redact.py.
Le commit source n’est pas fourni avec les références.

MIT License

Copyright (c) 2026 Pierre Samson and Claude Opus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

porté de swairm/oracle/nettoyage.py, commit 4a2b11f
*/

const motifs = [
  { source: '\\bsk-ant-[A-Za-z0-9\\-_]{8,}\\b', flags: '' },
  { source: '\\bsk-[A-Za-z0-9]{16,}\\b', flags: '' },
  { source: '\\bxai-[A-Za-z0-9\\-_]{16,}\\b', flags: '' },
  { source: '\\bAIza[0-9A-Za-z\\-_]{35}\\b', flags: '' },
  { source: '\\bgh[opusr]_[A-Za-z0-9_]{20,}\\b', flags: '' },
  { source: '\\bxox[baprs]-[A-Za-z0-9\\-]{8,}\\b', flags: '' },
  { source: '\\beyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+(?:\\.[A-Za-z0-9_\\-]+)?', flags: '' },
  { source: '\\bAKIA[0-9A-Z]{16}\\b', flags: '' },
  {
    source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    flags: 's',
  },
  {
    source: '\\b(password|passwd|pwd|api[_-]?key|auth[_-]?token|secret)\\b\\s*[:=]\\s*\\S+',
    flags: 'i',
  },
  { source: '\\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9\\-_]{16,}\\b', flags: '' },
  {
    source:
      '(?:\\bAIza[0-9A-Za-z\\-_]{34}(?:-|[0-9A-Za-z_](?![0-9A-Za-z_]))|(?<=[0-9A-Za-z_])AIza[0-9A-Za-z\\-_]{34}[0-9A-Za-z_](?![0-9A-Za-z_])|(?<=\\w)AIza[0-9A-Za-z\\-_]{34}-)',
    flags: '',
  },
  { source: '\\bhf_[A-Za-z0-9_-]{16,}\\b', flags: '' },
  { source: '\\bnpm_[A-Za-z0-9_-]{16,}\\b', flags: '' },
  { source: '\\bglpat-[A-Za-z0-9_-]{16,}\\b', flags: '' },
  { source: '\\bpypi-[A-Za-z0-9_-]{16,}\\b', flags: '' },
  { source: '\\bsk_live_[A-Za-z0-9_-]{16,}\\b', flags: '' },
  { source: '\\brk_live_[A-Za-z0-9_-]{16,}\\b', flags: '' },
  {
    source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    flags: 's',
  },
  { source: '\\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b', flags: '' },
  { source: '\\bsk-ant-[A-Za-z0-9\\-_]{8,}\\b', flags: '' },
  { source: '\\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9\\-_]{16,}\\b', flags: '' },
  { source: '\\bxai-[A-Za-z0-9\\-_]{16,}\\b', flags: '' },
  { source: '\\bAIza[0-9A-Za-z\\-_]{35}\\b', flags: '' },
  {
    source:
      '(?:\\bAIza[0-9A-Za-z\\-_]{34}(?:-|[0-9A-Za-z_](?![0-9A-Za-z_]))|(?<=[0-9A-Za-z_])AIza[0-9A-Za-z\\-_]{34}[0-9A-Za-z_](?![0-9A-Za-z_])|(?<=\\w)AIza[0-9A-Za-z\\-_]{34}-)',
    flags: '',
  },
  { source: '\\bxox[baprs]-[A-Za-z0-9\\-]{8,}\\b', flags: '' },
  { source: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', flags: '' },
  {
    source:
      '\\b(aws_secret_access_key|aws_session_token)\\b(\\s*[:=]\\s*)([\'\\"]?)(?!\\[REDACTED)[A-Za-z0-9/+=]{20,}\\3',
    flags: 'i',
  },
  {
    source: '\\beyJ[A-Za-z0-9_\\-]{4,}\\.eyJ[A-Za-z0-9_\\-]{4,}(?:\\.[A-Za-z0-9_\\-]{4,})?\\b',
    flags: '',
  },
  { source: '\\b(Bearer\\s+)(?!\\[REDACTED)[A-Za-z0-9\\-._~+/]{12,}=*', flags: 'i' },
  {
    source: '\\b([a-zA-Z][a-zA-Z0-9+.\\-]*://[^/\\s:@]+:)(?!\\[REDACTED)([^@\\s/]+)(@[^\\s/]+)',
    flags: '',
  },
  {
    source:
      '(?<!\\[)(?<![a-zA-Z0-9/._\\-:])(?!(?:REDACTED|CUSTOM):)([a-zA-Z0-9._\\-]+:)(?!\\[REDACTED)([^@\\s:/]{2,})(@(?:localhost|(?:[a-zA-Z0-9\\-]+\\.)+[a-zA-Z]{2,}|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d+)?)\\b',
    flags: '',
  },
  {
    source:
      '(?<![a-zA-Z0-9_])(?<!--)(password|passwd|pwd|api[_-]?key|auth[_-]?token|access[_-]?token|mesh_gateway_token|pgpassword|rediscli_auth|client_secret|secret)\\b(\\s*[:=]\\s*)(?!\\[REDACTED)([\'\\"]?)([^\\s\'\\"&;,)]+)\\3',
    flags: 'i',
  },
  { source: '\\b(mysql(?:dump|admin)?(?:\\s+[^\\n;|]+?)?\\s+-p)(?!\\[REDACTED)(\\S+)', flags: '' },
  {
    source:
      '\\b(mysql(?:dump|admin)?(?:\\s+[^\\n;|]+?)?\\s+--password(?:=|\\s+))(?!\\[REDACTED)(\\S+)',
    flags: '',
  },
  {
    source:
      '\\b(docker\\s+login(?:\\s+[^\\n;|]+?)?\\s+(?:-p|--password)(?:=|\\s+))(?!\\[REDACTED)(?!-|--password-stdin\\b)(\\S+)',
    flags: '',
  },
  { source: '\\b(sshpass\\s+-p\\s*)(?!\\[REDACTED)(\\S+)', flags: '' },
  {
    source: '\\b(curl(?:\\s+[^\\n;|]+?)?\\s+(?:-u|--user)\\s+[^:\\s]+:)(?!\\[REDACTED)(\\S+)',
    flags: '',
  },
].map(({ source, flags }) => new RegExp(source, flags));
const affectation = new RegExp(
  '\\b([a-z0-9_]*(?:token|secret|key|pass|cred|auth|private)[a-z0-9_]*)\\b(\\s*[:=]\\s*)([\'\\"]?)(?!\\[REDACTED)([A-Za-z0-9/+=\\-_]{16,})\\3',
  'ig',
);
const isole = new RegExp(
  '(?<![A-Za-z0-9/+\\-_/.])([A-Za-z0-9/+\\-_]{24,}=*)(?![A-Za-z0-9/+\\-_/.])',
  'g',
);
const exemples = [
  'change_me',
  'dummy',
  'example',
  'false',
  'none',
  'null',
  'placeholder',
  'redacted',
  'test',
  'true',
  'undefined',
  'your_token_here',
];

const hexadecimal = /^[0-9a-f]+$/i;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function entropie(texte: string): number {
  const comptes = new Map<string, number>();
  for (const c of texte) comptes.set(c, (comptes.get(c) ?? 0) + 1);
  return -[...comptes.values()].reduce(
    (s, n) => s + (n / texte.length) * Math.log2(n / texte.length),
    0,
  );
}
const classeCaractere = (c: string): number =>
  /[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /[0-9]/.test(c) ? 3 : 4;
function secretIsole(jeton: string): boolean {
  const coeur = jeton.replace(/=+$/, '');
  if (jeton.length < 24 || hexadecimal.test(coeur) || uuid.test(coeur)) return false;
  for (const separateur of ['-', '_']) {
    const suffixe = coeur.split(separateur).at(-1)!;
    if (coeur.includes(separateur) && suffixe.length >= 16 && hexadecimal.test(suffixe))
      return false;
  }
  if (
    jeton.includes('__') ||
    (jeton.match(/[_-]/g)?.length ?? 0) > 2 ||
    !/[A-Z]/.test(jeton) ||
    !/[a-z]/.test(jeton) ||
    (jeton.match(/[0-9]/g)?.length ?? 0) < 4 ||
    entropie(jeton) < 4.25
  )
    return false;
  let transitions = 0;
  for (let i = 1; i < jeton.length; i++)
    if (classeCaractere(jeton[i - 1]!) !== classeCaractere(jeton[i]!)) transitions++;
  return transitions / (jeton.length - 1) >= 0.4;
}

function ipv4(valeur: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(valeur)) return null;
  const octets = valeur.split('.').map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets.reduce((s, n) => s * 256 + n, 0);
}
function privee4(n: number): boolean {
  return [
    [0x64400000, 22],
    [0x0a000000, 24],
    [0xac100000, 20],
    [0xc0a80000, 16],
    [0x7f000000, 24],
    [0xa9fe0000, 16],
  ].some(([base, bits]) => Math.floor(n / 2 ** bits!) === base! / 2 ** bits!);
}
function ipv6(valeur: string): bigint | null {
  let adresse = valeur.split('%')[0]!;
  if (adresse.includes('.')) {
    const debut = adresse.lastIndexOf(':');
    const n = ipv4(adresse.slice(debut + 1));
    if (n === null) return null;
    adresse =
      adresse.slice(0, debut + 1) +
      Math.floor(n / 65536).toString(16) +
      ':' +
      (n % 65536).toString(16);
  }
  const parties = adresse.split('::');
  if (parties.length > 2) return null;
  const gauche = parties[0] ? parties[0].split(':') : [];
  const droite = parties[1] ? parties[1].split(':') : [];
  const manque = 8 - gauche.length - droite.length;
  if (parties.length === 1 ? manque !== 0 : manque < 1) return null;
  const groupes = [...gauche, ...Array<string>(manque).fill('0'), ...droite];
  if (groupes.some((s) => !/^[0-9a-f]{1,4}$/i.test(s))) return null;
  return groupes.reduce((n, s) => (n << 16n) + BigInt(parseInt(s, 16)), 0n);
}
function adressePrivee(candidat: string): boolean {
  let valeur = candidat.replace(/\.+$/, '');
  if (valeur.includes('.') && valeur.split(':').length === 2) valeur = valeur.split(':')[0]!;
  const v4 = ipv4(valeur);
  if (v4 !== null) return privee4(v4);
  const v6 = ipv6(valeur);
  if (v6 === null) return false;
  if (v6 === 1n || v6 >> 121n === 126n || v6 >> 118n === 1018n) return true;
  if (v6 >> 32n === 0xffffn || v6 >> 32n === 0x64ff9bn << 64n)
    return privee4(Number(v6 & 0xffffffffn));
  return false;
}

export function nettoyer(
  texte: string,
  { hotesPrives = [] }: { hotesPrives?: string[] } = {},
): { ok: true } | { ok: false; classe: string } {
  const refus = (classe: string) => ({ ok: false as const, classe });
  if (Array.from(texte).length > 20000) return refus('texte trop long');
  const controle = texte.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  if (motifs.some((motif) => motif.test(controle))) return refus('ressemble à une clé API');
  for (const m of controle.matchAll(affectation)) {
    const valeur = m[4]!;
    if (
      !exemples.some((p) => valeur.toLowerCase().includes(p)) &&
      !hexadecimal.test(valeur) &&
      !uuid.test(valeur) &&
      entropie(valeur) >= 3.6
    )
      return refus('ressemble à une clé API');
  }
  if ([...controle.matchAll(isole)].some((m) => secretIsole(m[1]!)))
    return refus('ressemble à une clé API');
  const hotes = hotesPrives.map((h) => h.toLowerCase().replace(/\.+$/, ''));
  for (const [nom] of controle.matchAll(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g)) {
    const h = nom.toLowerCase();
    if (h.endsWith('.ts.net') || hotes.some((prive) => h === prive || h.endsWith('.' + prive)))
      return refus('hôte privé');
  }
  if ([...controle.matchAll(/[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_-]+)?/g)].some(([c]) => adressePrivee(c)))
    return refus('adresse privée');
  return { ok: true };
}
