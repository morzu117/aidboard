// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Message } from '../../web/src/conversation/Message.js';
import { poseUneQuestion } from '../../web/src/ui/markdownMessage.js';

afterEach(cleanup);

const rendre = (text: string) =>
  render(
    <Message
      role="assistant"
      kind="claude"
      at="2026-10-30T09:00:00.000Z"
      text={text}
      dataNode="m"
    />,
  ).container;

test('le gras et les listes sont rendus, plus d’astérisques visibles', () => {
  const c = rendre('Voici :\n\n- **Q4 — Appariement** : par identifiant\n- autre point');
  expect(c.querySelector('strong')?.textContent).toBe('Q4 — Appariement');
  expect(c.querySelectorAll('li')).toHaveLength(2);
  expect(c.textContent).not.toContain('**');
});

test('deux titres ou plus : une carte par titre, le préambule reste hors carte', () => {
  const c = rendre('Intro\n\n**Premier**\n\ntexte un\n\n## Second\n\ntexte deux');
  const cartes = c.querySelectorAll('section.carte-md');
  expect(cartes).toHaveLength(2);
  expect(cartes[0]!.querySelector('.carte-md-titre')?.textContent).toBe('Premier');
  expect(cartes[1]!.textContent).toContain('texte deux');
  expect(c.querySelector('.message-agent-texte')!.firstElementChild!.tagName).toBe('DIV');
  expect(c.querySelector('.message-agent-texte > div .md-p')?.textContent).toBe('Intro');
});

test('un seul titre : pas de carte, le titre reste une ligne en tête', () => {
  const c = rendre('**Seul**\n\ntexte');
  expect(c.querySelector('.carte-md')).toBeNull();
  expect(c.querySelector('.carte-md-titre')?.textContent).toBe('Seul');
});

test('une question est mise en évidence, comptée dans l’en-tête, et colore sa carte', () => {
  const c = rendre(
    '**À trancher**\n\n- **Q8 — Git.**\n  - Hébergeur : GitHub ou GitLab ?\n- Recommandation : tout va bien.\n\n**Reste**\n\nrien',
  );
  expect(c.querySelectorAll('.md-question')).toHaveLength(1);
  expect(c.querySelector('.md-question')?.textContent).toContain('Q8');
  expect(c.querySelector('.message-agent-question')?.textContent).toBe('1 question');
  const cartes = c.querySelectorAll('section.carte-md');
  expect(cartes[0]!.classList.contains('carte-md--question')).toBe(true);
  expect(cartes[1]!.classList.contains('carte-md--question')).toBe(false);
});

test('sans question : pas de pastille', () => {
  expect(rendre('Terminé.').querySelector('.message-agent-question')).toBeNull();
});

test('poseUneQuestion : ponctuation française et fermants markdown, pas les codes en ligne', () => {
  expect(poseUneQuestion('On continue ?')).toBe(true);
  expect(poseUneQuestion('Tu veux *(recommandé)* ?*')).toBe(true);
  expect(poseUneQuestion('Pourquoi ?\nParce que.')).toBe(true);
  expect(poseUneQuestion('Utiliser `a ?`')).toBe(false);
  expect(poseUneQuestion('Voir :\n```js\nconst a = b ?\n```\nFin.')).toBe(false);
  expect(poseUneQuestion('Rien à demander.')).toBe(false);
});

test('le HTML d’un message n’est jamais injecté, y compris en bloc', () => {
  const c = rendre('<div onclick="x()">bloc</div>\n\n<img src=x onerror=alert(1)> fin');
  expect(c.querySelector('div[onclick]')).toBeNull();
  expect(c.querySelector('img')).toBeNull();
  expect(c.textContent).toContain('<div onclick="x()">bloc</div>');
});
