-- DM14 : verdicts locaux, jamais exportés dans le miroir git.
CREATE TABLE memory_duplicate_pairs (
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  revision_a INTEGER NOT NULL,
  revision_b INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('oui', 'non')),
  judged_at TEXT NOT NULL,
  PRIMARY KEY (slug_a, slug_b),
  CHECK (slug_a < slug_b)
);
