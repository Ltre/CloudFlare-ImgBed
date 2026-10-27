-- Recoverable garbage-collection claim lease.
ALTER TABLE disk_s3_objects ADD COLUMN gc_claimed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_disk_s3_gc_claim ON disk_s3_objects(status,gc_claimed_at);
