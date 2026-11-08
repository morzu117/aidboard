CREATE TABLE push_abonnements (
  appareil_id TEXT PRIMARY KEY REFERENCES appareils(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  cree_a TEXT NOT NULL
);
