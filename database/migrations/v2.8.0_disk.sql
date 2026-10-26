-- Cloudflare Pages/Workers: wrangler d1 execute <database> --file=database/migrations/v2.8.0_disk.sql --remote
-- Docker server executes this migration on startup. Never drop existing ImgBed records.
CREATE TABLE IF NOT EXISTS disk_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disk_nodes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
  source_id TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(space_id,parent_id,name),
  FOREIGN KEY(space_id) REFERENCES disk_spaces(id)
);
CREATE INDEX IF NOT EXISTS idx_disk_children ON disk_nodes(space_id,parent_id);
CREATE INDEX IF NOT EXISTS idx_disk_sources ON disk_nodes(source_id);
CREATE TABLE IF NOT EXISTS disk_grants (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('read','write')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(space_id) REFERENCES disk_spaces(id)
);
CREATE INDEX IF NOT EXISTS idx_disk_grants_space ON disk_grants(space_id);
CREATE TABLE IF NOT EXISTS disk_shares (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(space_id) REFERENCES disk_spaces(id)
);
CREATE INDEX IF NOT EXISTS idx_disk_shares_space ON disk_shares(space_id);