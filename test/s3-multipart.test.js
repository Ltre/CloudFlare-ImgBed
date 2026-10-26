import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../deploy/server/sqliteD1.js';
import {createSpace} from '../functions/utils/disk/core.js';
import {parseCompletionXml,initMultipart,getMultipart,partUpload,listParts,completeMultipart,clearMultipart,abortMultipart,listUploads} from '../functions/utils/disk/s3Multipart.js';
describe('S3 Multipart Upload',()=>{
 let db,space,uploads,aborted;
 const r2={
   async createMultipartUpload(key){const uploadId='r2-'+key;uploads.set(uploadId,{key,parts:new Map()});return {uploadId,abort:async()=>{aborted.add(uploadId);uploads.delete(uploadId);}};},
   resumeMultipartUpload(key,uploadId){
     const x=uploads.get(uploadId);if(!x||x.key!==key)throw Error('NO_UPLOAD');
     return {
       async uploadPart(partNumber,body){x.parts.set(partNumber,body);return {partNumber,etag:'part-'+partNumber};},
       async complete(parts){for(const p of parts)assert.ok(x.parts.has(p.partNumber));uploads.delete(uploadId);return {etag:'whole'};},
       async abort(){aborted.add(uploadId);uploads.delete(uploadId);}
     };
   }
 };
 beforeEach(async()=>{
   uploads=new Map();aborted=new Set();db=new SqliteD1(':memory:');
   for(const name of ['v2.8.0_disk.sql','v2.8.1_disk_s3_multipart.sql'])db.exec(readFileSync(new URL('../database/migrations/'+name,import.meta.url),'utf8'));
   space=await createSpace(db,'disk');
 });
 afterEach(()=>db.db.close());
 it('parses standard XML and rejects invalid ordering',()=>{
   const xml='<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part></CompleteMultipartUpload>';
   assert.deepEqual(parseCompletionXml(xml),[{partNumber:1,etag:'a'},{partNumber:2,etag:'b'}]);
   assert.throws(()=>parseCompletionXml('<CompleteMultipartUpload></CompleteMultipartUpload>'));
   assert.throws(()=>parseCompletionXml('<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>x</ETag></Part><Part><PartNumber>1</PartNumber><ETag>x</ETag></Part></CompleteMultipartUpload>'));
 });
 it('persists parts, completes and clears the upload manifest',async()=>{
   const {id}=await initMultipart(db,r2,space.id,'2026/big.mp4','video/mp4');
   const record=await getMultipart(db,space.id,'2026/big.mp4',id);
   await partUpload(db,r2,record,1,new Uint8Array(5*1024*1024),5*1024*1024);
   await partUpload(db,r2,record,2,new Uint8Array(25),25);
   assert.deepEqual((await listParts(db,record)).map(x=>x.part_number),[1,2]);
   assert.equal((await listUploads(db,space.id)).length,1);
   await assert.rejects(completeMultipart(db,r2,record,[{partNumber:1,etag:'BAD'}]),{code:'InvalidPart'});
   const complete=await completeMultipart(db,r2,record,[{partNumber:1,etag:'part-1'},{partNumber:2,etag:'part-2'}]);
   assert.equal(complete.size,5*1024*1024+25);
   assert.equal(complete.etag,'whole');
   await clearMultipart(db,record);
   await assert.rejects(getMultipart(db,space.id,'2026/big.mp4',id),{code:'NoSuchUpload'});
 });
 it('aborts R2 upload and removes D1 state',async()=>{
   const {id}=await initMultipart(db,r2,space.id,'abort.zip','application/zip');
   await abortMultipart(db,r2,await getMultipart(db,space.id,'abort.zip',id));
   assert.equal(aborted.size,1);assert.deepEqual(await listUploads(db,space.id),[]);
 });
});