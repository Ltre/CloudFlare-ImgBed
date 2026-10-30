-- Track only objects created by this virtual-disk S3 gateway.
-- Never garbage collect ordinary ImgBed uploads or externally managed objects.
CREATE TABLE IF NOT EXISTS disk_s3_objects (
  source_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','deleting'))
);
CREATE INDEX IF NOT EXISTS idx_disk_s3_gc ON disk_s3_objects(status,created_at);
-- Prevent racing copy/import after GC exclusively claims a source.
CREATE TRIGGER IF NOT EXISTS disk_gc_guard_insert
BEFORE INSERT ON disk_nodes
WHEN NEW.source_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM disk_s3_objects
 WHERE source_id=NEW.source_id AND status='deleting'
)
BEGIN SELECT RAISE(ABORT,'DISK_SOURCE_GC_IN_PROGRESS'); END;
CREATE TRIGGER IF NOT EXISTS disk_gc_guard_update
BEFORE UPDATE OF source_id ON disk_nodes
WHEN NEW.source_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM disk_s3_objects
 WHERE source_id=NEW.source_id AND status='deleting'
)
BEGIN SELECT RAISE(ABORT,'DISK_SOURCE_GC_IN_PROGRESS'); END;
