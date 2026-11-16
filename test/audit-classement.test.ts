import { describe, expect, it } from 'vitest';
import { classer, type Observation } from '../e2e/audit/classement.js';

const neutre: Observation = {
  actif: true,
  erreursConsole: 0,
  erreursPage: 0,
  reponses: [],
  requetes: [],
  navigation: false,
  mutations: 0,
  echecClic: false,
  daemonArrete: false,
};

describe('classement D343', () => {
  it.each([
    [{}, 'sans effet'],
    [{ actif: false }, 'desactive'],
    [{ requetes: [{ chemin: '/api/state' }] }, 'ok'],
    [{ navigation: true }, 'ok'],
    [{ mutations: 1 }, 'ok'],
    [{ reponses: [{ chemin: '/api/test', statut: 403 }], mutations: 1 }, 'refus'],
    [{ reponses: [{ chemin: '/api/test', statut: 503 }], actif: false }, 'erreur'],
    [{ erreursConsole: 1, reponses: [{ chemin: '/api/test', statut: 401 }] }, 'erreur'],
    [{ erreursPage: 1 }, 'erreur'],
    [
      { reponses: [{ chemin: '/api/swairm/board/101/commits', statut: 404 }], navigation: true },
      'ok',
    ],
    [{ reponses: [{ chemin: '/api/autre', statut: 404 }] }, 'refus'],
    [{ echecClic: true }, 'clic impossible'],
    [{ cibleDisparue: true }, 'cible disparue'],
    [{ dialogueAnnule: true }, 'annulé'],
    [{ saisie: 'audit' }, 'ok'],
    [{ filtreChange: true }, 'ok'],
    [{ daemonArrete: true }, 'sans effet'],
  ] as Array<[Partial<Observation>, string]>)('%j → %s', (observations, attendu) => {
    const releve = Object.freeze({ ...neutre, ...observations });
    expect(classer(releve)).toBe(attendu);
    expect(releve).toEqual({ ...neutre, ...observations });
  });
});
