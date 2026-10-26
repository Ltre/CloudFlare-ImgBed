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
  const cutoff=Date.now()-MIN_AGE_MS;
  const rows=await all(db, `SELECT o.source_id FROM disk_s3_objects o
    WHERE o.status='active' AND o.created_at<?
      AND NOT EXISTS(SELECT 1 FROM disk_nodes n WHERE n.source_id=o.source_id)
    ORDER BY o.created_at ASC LIMIT ?`,cutoff,limit);
  if(confirm!==true)return {dryRun:true,candidates:rows.map(x=>x.source_id),checked:rows.length,removed:0};
  const removed=[],failed=[],skipped=[];
  for(const {source_id:sourceId} of rows){
    try{
      const claimed=await run(db,`UPDATE disk_s3_objects SET status='deleting'
        WHERE source_id=? AND status='active' AND created_at<?
        AND NOT EXISTS(SELECT 1 FROM disk_nodes n WHERE n.source_id=?)`,
        sourceId,cutoff,sourceId);
      if(Number(claimed.meta?.changes)!==1){skipped.push(sourceId);continue;}
      // The guard triggers prevent new references after the claim.
      await r2.delete(sourceId);
      await getDatabase(context.env).delete(sourceId);
      await removeFileFromIndex(context,sourceId);
      await run(db,"DELETE FROM disk_s3_objects WHERE source_id=? AND status='deleting'",sourceId);
      removed.push(sourceId);
    }catch(error){
      failed.push({sourceId,error:String(error?.message||error).slice(0,150)});
      try{await run(db,"UPDATE disk_s3_objects SET status='active' WHERE source_id=? AND status='deleting'",sourceId);}catch(e){}
    }
  }
  return {dryRun:false,checked:rows.length,removed,failed,skipped};
}
