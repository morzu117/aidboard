import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

it.each([
  'Absence de token : requête rejetée.',
  'Contrôle de la key : vérification terminée.',
  'Contrôle du token : re\u0301ponse attendue.',
])('accepte la prose après une mention de clé (%s)', (texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

it.each([
  'Absence de token : refusée',
  'Contrôle du token : requete rejetée.',
  'Contrôle du token: requête rejetée.',
  'Contrôle du token :requête rejetée.',
  'Contrôle du token = requête rejetée.',
  'Contrôle du token : "requête rejetée".',
  'Contrôle du "token" : requête rejetée.',
  'Contrôle du service_token : requête rejetée.',
  'Contrôle du TOKEN : requête rejetée.',
  'Contrôle du token : requête2 rejetée.',
  'Contrôle du token : reλuête rejetée.',
  'token : requête rejetée.',
  'Contrôle du token : requête\nrejetée.',
  'Contrôle du token : requête rejetée. DB_PASSWORD=phrase',
  'Contrôle du password : requête rejetée.',
])('refuse les formes voisines (%s)', (texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});
