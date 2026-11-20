# Recette du chantier 57.12 — Entretien de la mémoire

Dans le relevé, consigner la forme des observations et les comptages. Omettre
les noms d’hôtes, les chemins personnels, les contenus de pages et les jetons.

Le retrait de gbrain (57.3) a sa propre fiche : [recette-chantier-57-gbrain-windows.md](recette-chantier-57-gbrain-windows.md).

## Couverture automatique

- Vitest couvre le filtrage des leçons dans la Boîte, les deux décisions et
  la relecture, les erreurs de lecture et de décision, et l’absence d’appel
  en mode appareil.
- Les tests CLI couvrent la sortie texte, le tableau JSON, le filtre d’état
  et le code 4 si le daemon est injoignable.
- `e2e/boite-entretien-memoire.spec.ts` sème des propositions en base de test
  et décide par clic sur un écran de 1280 × 720 et de 390 × 844. Le détecteur
  visuel contrôle également la section quand ses boutons sont présents.
- Les tests mémoire du chantier couvrent le rattrapage DM16, l’éligibilité
  DM15, la limite de jobs par nuit et la création seule du découpage DM13.
  La suite utilise des données temporaires et des modèles simulés ou désactivés.

## Recette réelle à cocher

Sur la tour de Julien, AID Server et Ollama tournent dans Ubuntu sous WSL2.
Décision du 20 novembre 2026.

### Préparer Ollama dans Ubuntu

- [ ] Installer avec `curl -fsSL https://ollama.com/install.sh | sh` dans
      Ubuntu. [Installation officielle pour Linux](https://docs.ollama.com/linux)
- [ ] Si systemd est actif, démarrer le service par
      `sudo systemctl enable --now ollama`. Sinon, lancer `ollama serve`
      dans un terminal WSL et le laisser ouvert, ou ajouter au fichier
      `/etc/wsl.conf` le bloc suivant. Après avoir arrêté les travaux en
      cours, lancer `wsl --shutdown` depuis PowerShell, rouvrir Ubuntu puis
      démarrer le service. [Activer systemd dans WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)

  ```ini
  [boot]
  systemd=true
  ```

- [ ] Depuis WSL, vérifier que
      `curl -fsS http://127.0.0.1:11434/api/version` renvoie un objet avec un
      champ `version`.
- [ ] Exécuter `ollama pull bge-m3` et `ollama pull qwen3:8b`, les deux
      modèles par défaut d’AID Server.
- [ ] Si la tour possède une carte NVIDIA, vérifier sa visibilité avec
      `nvidia-smi` dans WSL. Sans GPU pris en charge, prévoir une exécution
      de `qwen3:8b` sur CPU, plus lente. [Vérification du GPU](https://docs.ollama.com/linux#install-cuda-drivers-optional)
- [ ] Vérifier que `aid doctor` ne signale plus « ollama introuvable ».

### Vérifier les vecteurs avant l’entretien

- [ ] Redémarrer AID Server. Vérifier que `GET /api/memory/health` indique
      `vectors: ollama` ou que `aid doctor` indique la recherche hybride.
- [ ] Observer le rattrapage des pages existantes (DM16), sans `reindex`.
      Relire `GET /api/memory/health` jusqu’à `pendingJobs: 0`, avec
      `failedJobs: 0`. Consigner uniquement les comptages.
- [ ] Lancer `aid mem search "<termes>"` avec des termes d’une page
      antérieure au redémarrage, choisis sur place. Vérifier le mode
      `hybrid` et que la page fait partie des résultats.

### Activer l’entretien pour la nuit

- [ ] Dans `~/.aid/config.yaml`, fusionner le bloc ci-dessous avec le bloc
      `memory` existant, puis redémarrer AID Server. Le bloc reprend les
      réglages du modèle de configuration avec l’entretien activé.

  ```yaml
  memory:
    embeddings:
      provider: ollama
      model: bge-m3
      url: http://127.0.0.1:11434
    maintenance:
      enabled: true
      model: qwen3:8b
      window: "02:00-06:00"
      duplicateDistance: 0.15
      maxPerNight: 20
      splitLines: 40
    git:
      push: false
  ```

- [ ] Garder la tour allumée, sans veille Windows, entre 02:00 et 06:00
      (heure locale de WSL). Garder Ubuntu, Ollama et AID Server actifs.
      WSL s’arrête quand plus rien n’y tourne et les services systemd seuls
      ne maintiennent pas l’instance en vie.
      [Durée de vie de l’instance WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd#how-does-enabling-systemd-affect-the-wsl-architecture)

### Décider le matin et vérifier les critères du §7

- [ ] Lancer `aid mem proposals`, puis ouvrir « Entretien de la mémoire »
      dans la Boîte. Comparer les propositions ouvertes et vérifier qu’elles
      visent toutes des pages sous `lesson/`.
- [ ] Compter les jobs `maintain` créés dans la fenêtre (table
      `memory_jobs`, colonne `created_at` en UTC), tous états confondus.
      Le total est inférieur ou égal à `maxPerNight` (20 par défaut).
- [ ] Appliquer une proposition de chaque type disponible. Vérifier que Tags
      et Doublon modifient les métadonnées attendues et préservent le corps
      de la leçon. Vérifier que Découpage laisse la source intacte et crée
      uniquement de nouvelles pages (DM13). Vérifier qu’une collision de
      slug laisse la page existante intacte. Relever les types disponibles
      et les contrôles effectués.
- [ ] Rejeter une proposition. Vérifier son état avec
      `aid mem proposals --state rejected`, puis vérifier le lendemain
      qu’elle n’est pas reproposée sur la leçon inchangée.
- [ ] Vérifier que `aid mem purge --dry-run` et `aid mem usage` rendent
      un résultat.
- [ ] Si le miroir partagé fait partie de l’instance de recette, vérifier
      que deux machines partageant le même distant voient les mêmes leçons
      après démarrage.
- [ ] Consigner que la CI de la PR du correctif est verte (gate sous
      Node 22 et 24, e2e).
- [ ] Consigner la décision de Julien de garder l’entretien activé ou de
      remettre `memory.maintenance.enabled: false` et de redémarrer AID Server.
