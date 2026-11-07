import { ASK_TEXT_ANSWER } from '../../shared/question.js';
import type { PendingRequest } from '../../shared/model.js';

// Conserver la règle historique : toute réponse « no » est réservée à la saisie libre.
// Chaque entrée garde la référence de l'option d'origine, sans modifier le pending.
export function optionsAppareil(pending: PendingRequest) {
  return pending.options.filter((option) => option.answer !== ASK_TEXT_ANSWER.answer);
}
