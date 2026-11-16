import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Request, Response, ConsoleMessage } from '@playwright/test';
import { CLASSES, classer, type Classe, type Observation } from './classement.js';
import type { Ecran } from './environnement.js';

const SELECTEUR = 'button, a[href], [role="button"], summary, input, select, textarea';
export const FORMATS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

// Les exclusions restent visibles dans le rapport, hors du classement des clics.
export const EXCLUSIONS = [
  {
    champ: 'action',
    motif: /^daemon\.(maj|stop|restart|cycle)/,
    raison: 'Met à jour ou arrête le daemon audité.',
  },
  {
    champ: 'href',
    motif: /^http:\/\/127\.0\.0\.1:\d+\/restart/,
    raison: 'Ouvre le pont de redémarrage externe au harnais.',
  },
  {
    champ: 'texte',
    motif: /^(Arrêter|Quitter|Redémarrer) (A-I-D|le daemon|AID)/i,
    raison: 'Arrête le daemon audité.',
  },
  { champ: 'node', motif: /^1-3\.actions\.editeur$/, raison: 'Ouvre un éditeur externe.' },
  { champ: 'action', motif: /editeur\./, raison: 'Ouvre un éditeur externe.' },
  { champ: 'title', motif: /dans l.éditeur/i, raison: 'Ouvre un éditeur externe.' },
  {
    champ: 'href',
    motif: /^(?!https?:|\/|#|\?).+:/i,
    raison: 'Ouvre un programme externe par son protocole.',
  },
  {
    champ: 'href',
    motif: /^https?:\/\/(?!127\.0\.0\.1[:/]|aid-e2e\.ts\.net[:/])/,
    raison: 'Lien vers un site extérieur au harnais local.',
  },
] as const;

interface ElementReleve {
  node: string | null;
  texte: string;
  title: string;
  actif: boolean;
  href: string;
  action: string;
  cible: string;
  balise: string;
}
export interface Resultat extends ElementReleve {
  ecran: string;
  format: string;
  classe: Classe | null;
  exclusion: string | null;
  observation: Observation;
}
interface EcranReleve {
  nom: string;
  chemin: string;
  format: string;
  capture: string;
  erreurChargement: boolean;
}

const cheminPublic = (adresse: string) => {
  try {
    return new URL(adresse).pathname;
  } catch {
    return '/';
  }
};
const vide = (actif: boolean): Observation => ({
  actif,
  erreursConsole: 0,
  erreursPage: 0,
  reponses: [],
  requetes: [],
  navigation: false,
  mutations: 0,
  echecClic: false,
  daemonArrete: false,
});

async function relever(page: Page): Promise<ElementReleve[]> {
  return page.locator(SELECTEUR).evaluateAll((elements) =>
    elements.flatMap((e) => {
      const rectangle = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      if (
        !rectangle.width ||
        !rectangle.height ||
        style.visibility === 'hidden' ||
        style.display === 'none'
      )
        return [];
      const segments: string[] = [];
      let courant: Element | null = e;
      while (courant && courant !== document.documentElement) {
        const parent: Element | null = courant.parentElement;
        const position = parent
          ? [...parent.children]
              .filter((enfant) => enfant.tagName === courant!.tagName)
              .indexOf(courant) + 1
          : 1;
        segments.unshift(`${courant.tagName.toLowerCase()}:nth-of-type(${position})`);
        courant = parent;
      }
      return [
        {
          node: e.getAttribute('data-node'),
          texte: (
            e.textContent?.trim() ||
            e.getAttribute('aria-label') ||
            e.getAttribute('placeholder') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .slice(0, 240),
          title: e.getAttribute('title') ?? '',
          actif: !e.matches(':disabled, [aria-disabled="true"]') && !e.closest('[inert]'),
          href: e.getAttribute('href') ?? '',
          action: e.getAttribute('data-action') ?? '',
          cible: `html > ${segments.join(' > ')}`,
          balise: e.tagName.toLowerCase(),
        },
      ];
    }),
  );
}

async function cliquer(
  page: Page,
  element: ElementReleve,
  verifierDaemon: () => Promise<boolean>,
): Promise<Observation> {
  const observation = vide(element.actif);
  const consoleErreur = (message: ConsoleMessage) => {
    if (message.type() === 'error') observation.erreursConsole++;
  };
  const pageErreur = () => {
    observation.erreursPage++;
  };
  const reponse = (r: Response) => {
    if (r.status() >= 400)
      observation.reponses.push({ chemin: cheminPublic(r.url()), statut: r.status() });
  };
  const requete = (r: Request) => {
    observation.requetes.push({ chemin: cheminPublic(r.url()) });
  };
  let navigations = 0;
  const navigation = () => {
    navigations++;
  };
  page.on('console', consoleErreur);
  page.on('pageerror', pageErreur);
  page.on('response', reponse);
  page.on('request', requete);
  page.on('framenavigated', navigation);
  try {
    await page.evaluate(() => {
      const w = window as unknown as {
        __auditMutations: number;
        __auditObservateur: MutationObserver;
      };
      w.__auditMutations = 0;
      w.__auditObservateur = new MutationObserver((mutations) => {
        w.__auditMutations += mutations.length;
      });
      w.__auditObservateur.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
    });
    const elements = await relever(page);
    const memeIdentite = (candidat: ElementReleve) =>
      element.node !== null
        ? candidat.node === element.node
        : candidat.node === null &&
          candidat.balise === element.balise &&
          candidat.texte === element.texte &&
          candidat.title === element.title &&
          candidat.href === element.href &&
          candidat.action === element.action;
    const correspondances = elements.filter(memeIdentite);
    const retrouve =
      correspondances.find((c) => c.cible === element.cible) ??
      (correspondances.length === 1 ? correspondances[0] : undefined);
    // Un clic précédent peut déplacer ou retirer une ligne : suivre son identité, jamais son voisin.
    const cible = page.locator(retrouve?.cible ?? element.cible);
    if (!retrouve) {
      observation.echecClic = true;
    } else if (
      (await cible.isDisabled()) ||
      (await cible.getAttribute('aria-disabled')) === 'true'
    ) {
      observation.actif = false;
    } else {
      observation.actif = true;
      try {
        await cible.click({ timeout: 3000 });
      } catch {
        observation.echecClic = true;
      }
      await page.waitForTimeout(1500);
      observation.navigation = navigations > 0;
      observation.mutations = await page
        .evaluate(() => {
          const w = window as unknown as {
            __auditMutations?: number;
            __auditObservateur?: MutationObserver;
          };
          w.__auditObservateur?.disconnect();
          return w.__auditMutations ?? 0;
        })
        .catch(() => 0);
      observation.daemonArrete = !(await verifierDaemon());
    }
  } finally {
    page.off('console', consoleErreur);
    page.off('pageerror', pageErreur);
    page.off('response', reponse);
    page.off('request', requete);
    page.off('framenavigated', navigation);
  }
  return observation;
}

/** Recharge avant chaque clic ; les trouvailles sont des données et ne font jamais échouer le test. */
export async function explorer(options: {
  ecrans: Ecran[];
  verifierDaemon: () => Promise<boolean>;
  dossier?: string;
}) {
  const dossier = options.dossier ?? join(tmpdir(), 'aid-audit-ui');
  await mkdir(join(dossier, 'captures'), { recursive: true });
  const resultats: Resultat[] = [];
  const ecrans: EcranReleve[] = [];
  const compteurs = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<Classe, number>;
  const sauver = async () => {
    resultats.sort(
      (a, b) =>
        (a.classe === null ? 5 : CLASSES.indexOf(a.classe)) -
          (b.classe === null ? 5 : CLASSES.indexOf(b.classe)) ||
        a.ecran.localeCompare(b.ecran) ||
        a.format.localeCompare(b.format),
    );
    for (const classe of CLASSES)
      compteurs[classe] = resultats.filter((r) => r.classe === classe).length;
    const rapport = { version: 1, ecrans, compteurs, resultats };
    await writeFile(join(dossier, 'rapport.json'), JSON.stringify(rapport, null, 2) + '\n');
    const propre = (s: string) => s.replace(/[|\n\r]/g, ' ');
    const lignes = resultats.map(
      (r) =>
        `| ${r.classe ?? 'exclu'} | ${propre(r.ecran)} | ${r.format} | ${propre(r.node ?? '(sans data-node)')} | ${propre(r.texte)} | ${propre(r.exclusion ?? '')} |`,
    );
    await writeFile(
      join(dossier, 'rapport.md'),
      [
        '# Audit des interfaces',
        '',
        ...CLASSES.map((c) => `- ${c} : ${compteurs[c]}`),
        `- exclusions : ${resultats.filter((r) => r.exclusion).length}`,
        `- écrans non chargés : ${ecrans.filter((e) => e.erreurChargement).length}`,
        '',
        '| Classe | Écran | Format | data-node | Texte | Exclusion |',
        '| --- | --- | --- | --- | --- | --- |',
        ...lignes,
        '',
        '## Captures',
        '',
        ...ecrans.map((e) => `- [${propre(e.nom)} ${e.format}](${e.capture})`),
        '',
      ].join('\n'),
    );
    return rapport;
  };
  for (const ecran of options.ecrans) {
    for (const format of FORMATS) {
      const page = ecran.page;
      const taille = `${format.width}x${format.height}`;
      const capture = `captures/${String(ecrans.length + 1).padStart(3, '0')}-${taille}.png`;
      const relevéEcran: EcranReleve = {
        nom: ecran.nom,
        chemin: cheminPublic(ecran.chemin),
        format: taille,
        capture,
        erreurChargement: false,
      };
      ecrans.push(relevéEcran);
      await page.setViewportSize(format);
      const dialogue = (d: import('@playwright/test').Dialog) => d.dismiss();
      page.on('dialog', dialogue);
      try {
        await page.goto(ecran.chemin, { waitUntil: 'networkidle', timeout: 20_000 });
        await page.screenshot({ path: join(dossier, capture), fullPage: true });
        const elements = await relever(page);
        for (const element of elements) {
          const exclusion =
            EXCLUSIONS.find((r) => r.motif.test(element[r.champ] ?? ''))?.raison ?? null;
          let observation = vide(element.actif);
          if (!exclusion) {
            try {
              await page.goto(ecran.chemin, { waitUntil: 'networkidle', timeout: 20_000 });
              observation = await cliquer(page, element, options.verifierDaemon);
            } catch {
              observation.echecClic = true;
              observation.daemonArrete = !(await options.verifierDaemon());
            }
          }
          resultats.push({
            ...element,
            href: element.href ? cheminPublic(new URL(element.href, ecran.chemin).href) : '',
            ecran: ecran.nom,
            format: taille,
            exclusion,
            observation,
            classe: exclusion ? null : classer(observation),
          });
        }
      } catch {
        relevéEcran.erreurChargement = true;
        await options.verifierDaemon();
      } finally {
        page.off('dialog', dialogue);
        await sauver();
      }
    }
  }
  return sauver();
}
