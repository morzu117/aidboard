export const limitesBoucle =
  'La boucle vérifie les changements après coup. Un changement fait puis défait entre deux relevés peut passer inaperçu. Un processus qui quitte son groupe (setsid) échappe à l’arrêt du groupe. Un processus du même utilisateur peut lire l’environnement du daemon. Sous Linux, l’isolation bwrap peut réduire ces risques. Sur macOS, cette isolation est indisponible.';
