-- État dérivé des pages et provenance des liens déclarés dans le miroir.
ALTER TABLE memory_pages ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE memory_links (
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  type TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  PRIMARY KEY (from_slug, to_slug, type, declared_by)
);

CREATE INDEX memory_links_to_slug ON memory_links (to_slug);
CREATE INDEX memory_links_declared_by ON memory_links (declared_by);
