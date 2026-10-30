// Une phrase qui se termine par « ? » (ponctuation française comprise), éventuellement suivie d'un
// fermant markdown. Partagé : le daemon en déduit « attend une réponse », l'interface met la question en évidence.
const QUESTION = /\?[\s*_)»"”’']*$/m;

/** Les blocs de code et les codes en ligne sont ignorés : un `?` y est du code, pas une question. */
export const poseUneQuestion = (raw: string): boolean =>
  QUESTION.test(raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, ''));
