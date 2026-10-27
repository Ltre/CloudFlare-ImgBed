/**
 * Explicit administrator-only garbage collection of S3-owned R2 objects.
 * No automatic delete on virtual unlink: D1 conditionally claims sources
 * only after >=24h and only while zero virtual nodes reference them.
 * D1 triggers block new references during asynchronous provider deletion.
 */
import { requireDiskDb,DiskError,one,all,run } from './core.js';
import { getDatabase } from '../databaseAdapter.js';
import { removeFileFromIndex } from '../indexManager.js';
const MIN_AGE_MS=24*60*60*1000;
export async function registerS3Object(db,sourceId) {
  if(!/^disk-s3\/[a-f0-9-]{36}$/i.test(sourceId))throw new DiskError('INVALID_S3_SOURCE');
  await run(db,"INSERT OR IGNORE INTO disk_s3_objects(source_id,created_at,status) VALUES(?,?,'active')",
    sourceId,Date.now());
}
export async function collectUnusedS3Objects(context,{confirm=false,max=25}={}) {
  const db=requireDiskDb(context.env),r2=context.env.img_r2;
  if(!r2||typeof r2.delete!=='function')throw new DiskError('R2_REQUIRED',503);
  const limit=Math.max(1,Math.min(50,Number.isInteger(Number(max))?Number(max):25));
  const cutoff=Date.now()-MIN_AGE_MS,stale=Date.now()-10*60*1000;
  // Never collect an active multipart source. Stale deletion claims are
  // recoverable after ten minutes; the DB trigger guards against new refs.
  const rows=await all(db, `SELECT o.source_id FROM disk_s3_objects o
    WHERE o.created_at<?
      AND (o.status='active' OR
           (o.status='deleting' AND o.gc_claimed_at IS NOT NULL AND o.gc_claimed_at<?))
      AND NOT EXISTS(SELECT 1 FROM disk_nodes n WHERE n.source_id=o.source_id)
      AND NOT EXISTS(SELECT 1 FROM disk_s3_uploads u WHERE u.source_id=o.source_id)
    ORDER BY o.created_at ASC LIMIT ?`,cutoff,stale,limit);
  if(confirm!==true)return {dryRun:true,candidates:rows.map(x=>x.source_id),checked:rows.length,removed:0};
  const removed=[],failed=[],skipped=[];
  for(const {source_id:sourceId} of rows){
    try{
      const claimed=await run(db,`UPDATE disk_s3_objects
        SET status='deleting',gc_claimed_at=?
        WHERE source_id=? AND created_at<?
          AND (status='active' OR (status='deleting' AND gc_claimed_at<?))
          AND NOT EXISTS(SELECT 1 FROM disk_nodes n WHERE n.source_id=?)
          AND NOT EXISTS(SELECT 1 FROM disk_s3_uploads u WHERE u.source_id=?)`,
        Date.now(),sourceId,cutoff,stale,sourceId,sourceId);
      if(Number(claimed.meta?.changes)!==1){skipped.push(sourceId);continue;}
      // The guard triggers prevent new references after the claim.
      await r2.delete(sourceId);
      await getDatabase(context.env).delete(sourceId);
      const indexResult=await removeFileFromIndex(context,sourceId);
      if(indexResult?.success===false) throw new Error('INDEX_REBUILD_REQUIRED');
      await run(db,"DELETE FROM disk_s3_objects WHERE source_id=? AND status='deleting'",sourceId);
      removed.push(sourceId);
    }catch(error){
      failed.push({sourceId,error:String(error?.message||error).slice(0,150)});
      // R2 delete might already have succeeded; keep the claim protected.
      // After the lease becomes stale, deletion and index cleanup retry safely.
    }
  }
  return {dryRun:false,checked:rows.length,removed,failed,skipped};
}
