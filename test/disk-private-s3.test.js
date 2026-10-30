import assert from 'node:assert/strict';
import {loadFunction,memoryDatabase} from './helpers/loadFunction.js';
import {parseSingleByteRange} from '../functions/file/fileTools.js';
describe('private S3 objects under authorized disk capability',()=>{
 let db,route,reads;
 beforeEach(async()=>{
   db=memoryDatabase();reads=0;
   await db.put('disk-s3/private-id','',{metadata:{
     Channel:'CloudflareR2',FileName:'private.txt',FileType:'text/plain',
     FileSizeBytes:11,DiskS3Private:true,ListType:'Block'
   }});
   route=await loadFunction('functions/utils/disk/read.js',{
     getDatabase:()=>db,parseSingleByteRange,
     onRequest:()=>assert.fail('Must not call ImgBed public reader for private S3')
   });
 });
 function makeContext(method='GET',range=null){
   const bytes=new TextEncoder().encode('hello world');
   const img_r2={
     async head(){return {size:bytes.length,httpEtag:'"etag"'};},
     async get(id,opts){
       reads++;assert.equal(id,'disk-s3/private-id');
       const b=opts?.range?bytes.slice(opts.range.offset,opts.range.offset+opts.range.length):bytes;
       return {body:new Response(b).body,size:bytes.length};
     }
   };
   return {env:{img_r2},request:new Request('https://disk.example/api/disk-share/t',{method,
     headers:range?{Range:range}:{}})};
 }
 it('returns byte-range content only through pre-authorized helper',async()=>{
   const response=await route.readSource(makeContext('GET','bytes=-5'),'disk-s3/private-id',true);
   assert.equal(response.status,206);
   assert.equal(response.headers.get('Content-Range'),'bytes 6-10/11');
   assert.equal(response.headers.get('Cache-Control'),'private, no-store, max-age=0');
   assert.equal(await response.text(),'world');
   assert.equal(reads,1);
 });
 it('rejects out-of-bounds ranges without fetching',async()=>{
   const response=await route.readSource(makeContext('GET','bytes=200-'),'disk-s3/private-id',true);
   assert.equal(response.status,416);assert.equal(reads,0);
 });
 it('handles HEAD without reading the content',async()=>{
   const response=await route.readSource(makeContext('HEAD'),'disk-s3/private-id',true);
   assert.equal(response.status,200);assert.equal(response.headers.get('Content-Length'),'11');
   assert.equal(reads,0);
 });
});
