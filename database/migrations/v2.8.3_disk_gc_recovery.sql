-- Recoverable garbage-collection claim lease.
ALTER TABLE disk_s3_objects ADD COLUMN gc_claimed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_disk_s3_gc_claim ON disk_s3_objects(status,gc_claimed_at);
-- Previously interrupted v2.8.2 GC attempts have no lease timestamp.
-- Protect them for ten minutes following migration before safe retry.
UPDATE disk_s3_objects
SET gc_claimed_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE status='deleting' AND gc_claimed_at IS NULL;
