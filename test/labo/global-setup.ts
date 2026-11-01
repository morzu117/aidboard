import { construireImage, verifierDocker } from './labo.js';

/** Chantier 18 : l'image est construite une fois pour tout le run, avant les fichiers de test. */
export default function setup(): void {
  verifierDocker();
  construireImage();
}
