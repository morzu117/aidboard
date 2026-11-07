// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RappelInstallation } from '../../web/src/ui/RappelInstallation.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function navigateur(appareil: string, installe = false, autonome = false) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(appareil);
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: autonome });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: installe })),
  });
}

test.each(['iPhone', 'iPad'])('32.8 : rappel sur %s Safari, fermé durablement', (appareil) => {
  navigateur(`${appareil} Version/18 Safari/605`);
  const vue = render(<RappelInstallation />);
  expect(
    screen.getByText(
      "Pour les notifications et l'écran plein, ajoute A-I-D à l'écran d'accueil : Partager, puis Sur l'écran d'accueil.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fermer le rappel' }));
  expect(screen.queryByRole('complementary')).toBeNull();
  vue.unmount();
  render(<RappelInstallation />);
  expect(screen.queryByRole('complementary')).toBeNull();
});

test.each([
  ['Android Safari/537', false, false],
  ['iPhone Safari/605', true, false],
  ['iPhone Safari/605', false, true],
  ['iPhone CriOS/100 Safari/605', false, false],
] as const)(
  '32.8 : pas de rappel pour %s (installé %s, standalone %s)',
  (ua, installe, autonome) => {
    navigateur(ua, installe, autonome);
    render(<RappelInstallation />);
    expect(screen.queryByRole('complementary')).toBeNull();
  },
);

test('32.8 : le refus de localStorage ne casse ni le rappel ni sa fermeture', () => {
  navigateur('iPhone Safari/605');
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Interdit');
  });
  render(<RappelInstallation />);
  fireEvent.click(screen.getByRole('button', { name: 'Fermer le rappel' }));
  expect(screen.queryByRole('complementary')).toBeNull();
});
