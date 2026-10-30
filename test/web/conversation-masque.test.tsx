// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../../web/src/styles/app.css'), 'utf8');

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style').forEach((s) => s.remove());
});

// Régression : `.conversation { display: flex }`, déclarée après `.masque { display: none }` à
// spécificité égale, l'emportait. La Conversation d'un onglet non actif restait affichée au-dessus
// de celle de l'onglet choisi : deux agents montraient le même fil.
test('la conversation d’un onglet non actif est masquée, la conversation active reste affichée', () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  render(
    <>
      <div className="conversation masque" data-testid="inactive" />
      <div className="conversation" data-testid="active" />
    </>,
  );
  expect(getComputedStyle(screen.getByTestId('inactive')).display).toBe('none');
  expect(getComputedStyle(screen.getByTestId('active')).display).toBe('flex');
});
