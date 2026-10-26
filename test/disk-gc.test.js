import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../deploy/server/sqliteD1.js';
import {createSpace,insertNode,uuid} from '../functions/utils/disk/core.js';
import {registerS3Object,collectUnusedS3Objects} from '../functions/utils/disk/gc.js';
describe('Safe S3 storage garbage collection',()=>{
 let db,space,deletes,kv,r2,ctx;
 const expired=Date.now()-25*3600*1000;
 beforeEach(async()=>{
   db=new SqliteD1(':memory:');
   for(const sql of ['v2.8.0_disk.sql','v2.8.1_disk_s3_multipart.sql','v2.8.2_disk_gc.sql'])
     db.exec(readFileSync(new URL('../database/migrations/'+sql,import.meta.url),'utf8'));
   space=await createSpace(db,'storage');
   deletes=[];kv=new Map();
   r2={async delete(id){deletes.push(id);}};
   ctx={env:{img_d1:db,img_r2:r2,img_url:{
     get:async id=>kv.get(id)||null,put:async(id,value)=>kv.set(id,value),
     delete:async id=>kv.delete(id),getWithMetadata:async()=>null
   }}};
 });
 afterEach(()=>db.db.close());
 async function oldSource(){
   const id='disk-s3/'+uuid();
   await registerS3Object(db,id);
   await db.prepare('UPDATE disk_s3_objects SET created_at=? WHERE source_id=?').bind(expired,id).run();
   return id;
 }
 it('does not reclaim referenced sources',async()=>{
   const source=await oldSource();
   await insertNode(db,{id:uuid(),space_id:space.id,parent_id:'',name:'still-owned.txt',
     kind:'file',source_id:source,mime:'text/plain',size:10,is_public:0,created_at:1,updated_at:1});
   const dry=await collectUnusedS3Objects(ctx,{max:10});
   assert.equal(dry.checked,0);assert.deepEqual(deletes,[]);
 });
 it('previews candidates, rechecks, and deletes only unlinked objects',async()=>{
   const source=await oldSource();
   const dry=await collectUnusedS3Objects(ctx,{max:10});
   assert.deepEqual(dry.candidates,[source]);assert.deepEqual(deletes,[]);
   const committed=await collectUnusedS3Objects(ctx,{confirm:true,max:10});
   assert.deepEqual(committed.removed,[source]);
   assert.deepEqual(deletes,[source]);
   assert.equal((await db.prepare('SELECT * FROM disk_s3_objects WHERE source_id=?').bind(source).first()),null);
 });
 it('blocks creating references to sources claimed by the collector',async()=>{
   const source=await oldSource();
   await db.prepare("UPDATE disk_s3_objects SET status='deleting' WHERE source_id=?").bind(source).run();
   await assert.rejects(insertNode(db,{id:uuid(),space_id:space.id,parent_id:'',name:'racing.txt',
     kind:'file',source_id:source,mime:'text/plain',size:10,is_public:0,created_at:1,updated_at:1}));
 });
 it('does not delete objects younger than 24 hours',async()=>{
   const source='disk-s3/'+uuid();
   await registerS3Object(db,source);
   assert.equal((await collectUnusedS3Objects(ctx,{confirm:true})).checked,0);
   assert.deepEqual(deletes,[]);
 });
});
