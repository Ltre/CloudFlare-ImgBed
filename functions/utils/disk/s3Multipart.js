/**
 * Stateful AWS S3 Multipart operations backed by D1 + Cloudflare R2 multipart.
 * The manifest is durable across Workers/Pages isolates; no Node.js runtime.
 * Multipart is isolated from ImgBed's existing provider upload implementation.
 */
import { uuid, one, all, run, DiskError } from './core.js';
import { registerS3Object } from './gc.js';

export function parseCompletionXml(xml) {
  if (typeof xml !== 'string' || xml.length > 1024*1024) throw new DiskError('MALFORMED_MULTIPART_XML');
  const outer=/^\s*(?:<\?xml[^>]*>\s*)?<CompleteMultipartUpload(?:\s[^>]*)?>([\s\S]*)<\/CompleteMultipartUpload>\s*$/.exec(xml);
  if(!outer) throw new DiskError('MALFORMED_MULTIPART_XML');
  const body=outer[1], result=[], partRe=/<Part>([\s\S]*?)<\/Part>/g;
  let m;
  while((m=partRe.exec(body))!==null) {
    const number=/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(m[1]);
    const tag=/<ETag>\s*([^<]+)\s*<\/ETag>/.exec(m[1]);
    if(!number||!tag) throw new DiskError('MALFORMED_MULTIPART_XML');
    const index=Number(number[1]);
    const etag=tag[1].trim().replace(/^&quot;|&quot;$/g,'').replace(/^"|"$/g,'');
    if (!Number.isInteger(index)||index<1||index>10000||!etag||etag.length>256||
      (result.length && result.at(-1).partNumber>=index)) throw new DiskError('INVALID_PART_ORDER');
    result.push({partNumber:index,etag});
  }
  if(!result.length || body.replace(partRe,'').trim()) throw new DiskError('MALFORMED_MULTIPART_XML');
  return result;
}
export async function initMultipart(db,r2,spaceId,key,mime) {
  if(!r2 || typeof r2.createMultipartUpload!=='function') throw new DiskError('R2_REQUIRED',503);
  const id=uuid(),sourceId='disk-s3/'+uuid(),now=Date.now();
  const upload=await r2.createMultipartUpload(sourceId,{httpMetadata:{contentType:mime}});
  try{
    await run(db,'INSERT INTO disk_s3_uploads(id,r2_upload_id,space_id,object_key,source_id,mime,created_at) VALUES(?,?,?,?,?,?,?)',
      id,upload.uploadId,spaceId,key,sourceId,mime,now);
    // Track the source before R2 multipart completion, so a crash after
    // complete() cannot strand an unregistered R2 object.
    await registerS3Object(db,sourceId);
  }catch(e){
    await upload.abort();
    try{await run(db,'DELETE FROM disk_s3_uploads WHERE id=?',id);}catch(_){}
    try{await run(db,'DELETE FROM disk_s3_objects WHERE source_id=?',sourceId);}catch(_){}
    throw e;
  }
  return {id,sourceId};
}
export async function getMultipart(db,spaceId,key,id) {
  if(!id || id.length>128) throw new DiskError('NoSuchUpload',404);
  const record=await one(db,'SELECT * FROM disk_s3_uploads WHERE id=? AND space_id=? AND object_key=?',id,spaceId,key);
  if(!record) throw new DiskError('NoSuchUpload',404);
  return record;
}
export function resumeMultipart(r2,record) {
  if(!r2 || typeof r2.resumeMultipartUpload!=='function') throw new DiskError('R2_REQUIRED',503);
  return r2.resumeMultipartUpload(record.source_id,record.r2_upload_id);
}
export async function partUpload(db,r2,record,partNumber,body,size) {
  if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000) throw new DiskError('InvalidPart',400);
  if(!Number.isSafeInteger(size)||size<1) throw new DiskError('InvalidPart',400);
  const result=await resumeMultipart(r2,record).uploadPart(partNumber,body);
  const etag=String(result.etag || '').replace(/^"|"$/g,'');
  if(!etag) throw new DiskError('InvalidPart',500);
  await run(db,'INSERT INTO disk_s3_upload_parts(upload_id,part_number,etag,size) VALUES(?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size',
    record.id,partNumber,etag,size);
  return etag;
}
export async function listParts(db,record) {
  return all(db,'SELECT part_number,etag,size FROM disk_s3_upload_parts WHERE upload_id=? ORDER BY part_number',record.id);
}
export async function completeMultipart(db,r2,record,parts) {
  const existing=await listParts(db,record);
  const byNumber=new Map(existing.map(p=>[p.part_number,p]));
  for (const part of parts) {
    const stored=byNumber.get(part.partNumber);
    if(!stored||stored.etag!==part.etag) throw new DiskError('InvalidPart',400);
  }
  // R2 enforces its own multipart size constraints, including minimum part size.
  const size=parts.reduce((sum,p)=>sum+Number(byNumber.get(p.partNumber).size),0);
  if(!Number.isSafeInteger(size)) throw new DiskError('EntityTooLarge',413);
  try {
    const result=await resumeMultipart(r2,record).complete(parts);
    return { size,etag:String(result?.etag||'') };
  } catch(error) {
    // Cloudflare may have finalized the upload but the response was lost.
    // A retry can safely recover if the newly assigned source ID now exists.
    let existing=null;
    try {
      existing=typeof r2.head==='function' ? await r2.head(record.source_id) :
        typeof r2.get==='function' ? await r2.get(record.source_id) : null;
      if(existing?.body && typeof existing.body.cancel==='function') {
        await existing.body.cancel();
      }
    }catch(_) {}
    if(existing && Number(existing.size)===size)
      return { size,etag:String(existing.etag||'') };
    throw error;
  }
}
export async function clearMultipart(db,record) {
  await run(db,'DELETE FROM disk_s3_upload_parts WHERE upload_id=?',record.id);
  await run(db,'DELETE FROM disk_s3_uploads WHERE id=?',record.id);
}
export async function abortMultipart(db,r2,record) {
  await resumeMultipart(r2,record).abort();
  await clearMultipart(db,record);
  await run(db,"DELETE FROM disk_s3_objects WHERE source_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM disk_nodes WHERE source_id=?)",
    record.source_id,record.source_id);
}
export async function listUploads(db,spaceId) {
  return all(db,'SELECT id,object_key,created_at FROM disk_s3_uploads WHERE space_id=? ORDER BY created_at LIMIT 1000',spaceId);
}
