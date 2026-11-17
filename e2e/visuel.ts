import type { Page } from '@playwright/test';

export interface TrouvailleVisuelle {
  regle: 'style par défaut' | 'contraste' | 'débordement' | 'texte écrasé' | 'chevauchement';
  selecteur: string;
  node: string | null;
  texte: string;
  mesures: Record<string, number | string>;
}

export const EXCEPTIONS_VISUELLES = [
  { selecteur: '.xterm', raison: 'xterm dessine les cellules et superpose sa saisie native.' },
  {
    selecteur: '[data-visuel-exception]',
    raison: 'Exception déclarée par le composant ; sa raison doit figurer dans cet attribut.',
  },
];

/** D346 : mesures dans le navigateur, sans image ni dépendance externe. */
export async function detecterVisuel(page: Page): Promise<TrouvailleVisuelle[]> {
  return page.evaluate((exceptions) => {
    const trouvailles: TrouvailleVisuelle[] = [];
    const iframe = document.createElement('iframe');
    iframe.src = 'about:blank';
    iframe.style.display = 'none';
    document.body.append(iframe);
    const vierge = iframe.contentDocument!;
    const vue = iframe.contentWindow!;
    const temoins = new Map<string, CSSStyleDeclaration>();
    const temoin = (e: Element) => {
      const cle = `${e.tagName}:${e.getAttribute('type') ?? ''}:${e.matches(':disabled')}`;
      if (!temoins.has(cle)) {
        const copie = vierge.createElement(e.tagName);
        for (const attribut of ['type', 'disabled', 'href']) {
          if (e.hasAttribute(attribut)) copie.setAttribute(attribut, e.getAttribute(attribut)!);
        }
        vierge.body.append(copie);
        temoins.set(cle, vue.getComputedStyle(copie));
      }
      return temoins.get(cle)!;
    };
    const selecteur = (e: Element): string => {
      if (e.id) return `#${CSS.escape(e.id)}`;
      const parent = e.parentElement;
      if (!parent) return e.tagName.toLowerCase();
      const index = [...parent.children].filter((c) => c.tagName === e.tagName).indexOf(e) + 1;
      return `${selecteur(parent)} > ${e.tagName.toLowerCase()}:nth-of-type(${index})`;
    };
    const ajouter = (
      e: Element,
      regle: TrouvailleVisuelle['regle'],
      mesures: TrouvailleVisuelle['mesures'],
    ) => {
      trouvailles.push({
        regle,
        selecteur: selecteur(e),
        node: e.getAttribute('data-node'),
        texte: (
          e.textContent ||
          e.getAttribute('aria-label') ||
          (e as HTMLInputElement).labels?.[0]?.textContent ||
          e.getAttribute('placeholder') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
        mesures,
      });
    };
    type Couleur = [number, number, number, number];
    const couleur = (texte: string): Couleur => {
      const nombres = texte.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [nombres[0] ?? 0, nombres[1] ?? 0, nombres[2] ?? 0, nombres[3] ?? 1];
    };
    const composer = (avant: Couleur, fond: Couleur): Couleur => {
      const alpha = avant[3] + fond[3] * (1 - avant[3]);
      return [0, 1, 2]
        .map((i) =>
          alpha ? (avant[i]! * avant[3] + fond[i]! * fond[3] * (1 - avant[3])) / alpha : 0,
        )
        .concat(alpha) as Couleur;
    };
    const fondEffectif = (e: Element): Couleur => {
      let fond: Couleur = [0, 0, 0, 0];
      let courant: Element | null = e;
      while (courant) {
        fond = composer(fond, couleur(getComputedStyle(courant).backgroundColor));
        if (fond[3] >= 0.999) return fond;
        courant = courant.parentElement;
      }
      return composer(fond, [255, 255, 255, 1]);
    };
    const luminance = (c: Couleur) =>
      c
        .slice(0, 3)
        .map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const defile = (e: Element): boolean => {
      for (let courant: Element | null = e; courant; courant = courant.parentElement) {
        const style = getComputedStyle(courant);
        if (
          /(auto|scroll)/.test(style.overflowX) &&
          courant.scrollWidth > courant.clientWidth + 1 &&
          courant.getBoundingClientRect().left >= -1 &&
          courant.getBoundingClientRect().right <= innerWidth + 1
        )
          return true;
      }
      return false;
    };
    const rogne = (e: Element) => {
      const style = getComputedStyle(e);
      return style.textOverflow === 'ellipsis' && /(hidden|clip)/.test(style.overflowX);
    };
    const textes = new Map<Element, DOMRect[]>();
    try {
      for (const e of document.body.querySelectorAll('*')) {
        if (
          !(e instanceof HTMLElement) ||
          e === iframe ||
          e.closest(exceptions.map((x) => x.selecteur).join(','))
        )
          continue;
        const style = getComputedStyle(e);
        const boite = e.getBoundingClientRect();
        if (
          !boite.width ||
          !boite.height ||
          style.visibility !== 'visible' ||
          style.display === 'none' ||
          e.closest('[inert], [aria-hidden="true"]')
        )
          continue;
        let invisible = false;
        for (let a: Element | null = e; a; a = a.parentElement) {
          const aspect = getComputedStyle(a);
          if (
            Number(aspect.opacity) === 0 ||
            aspect.clip === 'rect(0px, 0px, 0px, 0px)' ||
            aspect.clipPath === 'inset(50%)'
          )
            invisible = true;
        }
        if (invisible) continue;
        if (e.matches('button, input:not([type=hidden]), select, textarea, a[href]')) {
          const natif = temoin(e);
          const proprietes = e.matches('a')
            ? ['color']
            : e.matches('input[type=checkbox], input[type=radio]')
              ? ['accent-color']
              : [
                  'background-color',
                  'border-top-style',
                  'border-top-color',
                  'border-top-width',
                  'color',
                ];
          const identiques = proprietes.filter(
            (p) => style.getPropertyValue(p) === natif.getPropertyValue(p),
          );
          // Une couleur héritée seule ne suffit pas : elle peut être voulue dans le thème clair.
          const bordureNative =
            identiques.includes('border-top-style') &&
            style.borderTopStyle !== 'none' &&
            identiques.includes('border-top-color') &&
            identiques.includes('border-top-width');
          const parDefaut = e.matches('a, input[type=checkbox], input[type=radio]')
            ? identiques.length === proprietes.length
            : bordureNative ||
              (identiques.includes('background-color') && identiques.includes('color'));
          if (parDefaut)
            ajouter(e, 'style par défaut', {
              proprietes: identiques.join(', '),
              valeurs: identiques.map((p) => `${p}: ${style.getPropertyValue(p)}`).join('; '),
            });
        }
        if (
          e.clientWidth &&
          !rogne(e) &&
          !defile(e) &&
          (e.scrollWidth > e.clientWidth + 1 || boite.right > innerWidth + 1 || boite.left < -1)
        ) {
          ajouter(e, 'débordement', {
            scrollWidth: e.scrollWidth,
            clientWidth: e.clientWidth,
            gauche: boite.left,
            droite: boite.right,
            fenetre: innerWidth,
          });
        }
        const noeuds = [...e.childNodes].filter(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
        );
        // Une case ou un curseur n'a pas de texte : sa couleur CSS ne mesure pas un contraste lisible.
        const champTexte = e.matches(
          'textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=image])',
        );
        const valeur = champTexte ? (e as HTMLInputElement).value : '';
        const placeholder = champTexte && !valeur ? e.getAttribute('placeholder') : null;
        if (!noeuds.length && !(champTexte && (valeur || placeholder))) continue;
        const styleTexte = placeholder ? getComputedStyle(e, '::placeholder') : style;
        const rectangles: DOMRect[] = [];
        for (const n of noeuds) {
          const plage = document.createRange();
          plage.selectNodeContents(n);
          rectangles.push(...plage.getClientRects());
        }
        if (rectangles.length) textes.set(e, rectangles);
        const fond = fondEffectif(e);
        let encre = composer(couleur(styleTexte.color), fond);
        if (placeholder)
          encre = composer([encre[0], encre[1], encre[2], Number(styleTexte.opacity)], fond);
        // L'opacité d'un contrôle désactivé fait partie de son contraste apparent.
        for (let a: Element | null = e; a; a = a.parentElement) {
          encre = composer(
            [encre[0], encre[1], encre[2], Number(getComputedStyle(a).opacity)],
            fond,
          );
        }
        const l1 = luminance(encre),
          l2 = luminance(fond);
        const contraste = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const gros =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        const seuil = gros || !!e.closest(':disabled, [aria-disabled="true"]') ? 3 : 4.5;
        if (contraste + 0.01 < seuil)
          ajouter(e, 'contraste', {
            contraste,
            seuil,
            couleur: styleTexte.color,
            fond: fond.join(','),
          });
        const texte = noeuds
          .map((n) => n.textContent)
          .join(' ')
          .trim();
        const lignes = new Set(rectangles.filter((r) => r.width > 0).map((r) => Math.round(r.top)))
          .size;
        const mots = texte.split(/\s+/).length;
        // Un code de pleine largeur peut couper une chaîne technique sans espaces.
        // Un code étroit ou une lettre par ligne reste un défaut.
        const codeLisible =
          e.tagName === 'CODE' &&
          style.display === 'block' &&
          style.overflowWrap === 'anywhere' &&
          style.wordBreak === 'normal' &&
          e.getBoundingClientRect().width >= Math.min(200, innerWidth * 0.8) &&
          texte.length / lignes >= 16;
        if (texte.length <= 120 && lignes > mots && !rogne(e) && !codeLisible)
          ajouter(e, 'texte écrasé', { lignes, mots });
      }
      // Les fragments masqués par une ellipse ne peuvent pas recouvrir un texte voisin.
      const partieVisible = (rectangle: DOMRect, element: Element) => {
        let gauche = rectangle.left,
          droite = rectangle.right,
          haut = rectangle.top,
          bas = rectangle.bottom;
        for (let courant: Element | null = element; courant; courant = courant.parentElement) {
          const style = getComputedStyle(courant);
          const boite = courant.getBoundingClientRect();
          if (['hidden', 'clip'].includes(style.overflowX)) {
            gauche = Math.max(gauche, boite.left);
            droite = Math.min(droite, boite.right);
          }
          if (['hidden', 'clip'].includes(style.overflowY)) {
            haut = Math.max(haut, boite.top);
            bas = Math.min(bas, boite.bottom);
          }
        }
        return { left: gauche, right: droite, top: haut, bottom: bas };
      };
      const elements = [...textes.keys()];
      for (let i = 0; i < elements.length; i++) {
        const a = elements[i]!;
        for (let j = i + 1; j < elements.length; j++) {
          const b = elements[j]!;
          if (a.parentElement !== b.parentElement) continue;
          let largeur = 0,
            hauteur = 0;
          const recouvre = textes.get(a)!.some((rectangleA) =>
            textes.get(b)!.some((rectangleB) => {
              const r = partieVisible(rectangleA, a);
              const s = partieVisible(rectangleB, b);
              const l = Math.min(r.right, s.right) - Math.max(r.left, s.left);
              const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
              if (l <= 1 || h <= 1) return false;
              largeur = l;
              hauteur = h;
              return true;
            }),
          );
          if (recouvre) ajouter(a, 'chevauchement', { autre: selecteur(b), largeur, hauteur });
        }
      }
      return trouvailles;
    } finally {
      iframe.remove();
    }
  }, EXCEPTIONS_VISUELLES);
}
