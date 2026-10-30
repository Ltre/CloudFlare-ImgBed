-- S3-compatible multipart uploads: R2 is the only supported write backend.
-- All tables are separate from the existing ImgBed metadata index.
CREATE TABLE IF NOT EXISTS disk_s3_uploads(
  id TEXT PRIMARY KEY,
  r2_upload_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(space_id) REFERENCES disk_spaces(id)
);
CREATE TABLE IF NOT EXISTS disk_s3_upload_parts(
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY(upload_id,part_number)
);
CREATE INDEX IF NOT EXISTS idx_disk_s3_uploads_space ON disk_s3_uploads(space_id,object_key);
