import assert from 'node:assert/strict';
import {loadFunction, memoryDatabase} from './helpers/loadFunction.js';
import {parseSingleByteRange} from '../functions/file/fileTools.js';

describe('S3 byte-range / If-Range response semantics',()=>{
  const bytes=new TextEncoder().encode('hello world');
  const sourceId='disk-s3/12345678-2222-4444-8888-000000000000';
  const node={id:'virtual-node',source_id:sourceId,name:'video.mp4',
    mime:'video/mp4',size:bytes.length};
  async function handler(options={}){
    const db=memoryDatabase();
    const backingId=options.channel==='TelegramNew'?'telegram/original-id':sourceId;
    const fileNode={...node,source_id:backingId};
    await db.put(backingId,'',{metadata:{Channel:options.channel||'CloudflareR2',
      DiskS3Private:options.channel!=='TelegramNew',
      ListType:options.channel==='TelegramNew'?'White':'Block'}});
    const operations=[];
    const r2={
      async get(id,range){
        assert.equal(id,backingId);
        operations.push(range||null);
        const span=range?.range;
        const payload=span?bytes.slice(span.offset,span.offset+span.length):bytes;
        return {size:bytes.length,body:new Response(payload).body};
      }
    };
    const readerCalls=[];
    const route=await loadFunction('functions/s3/[[path]].js',{
      getDatabase:()=>db,
      parseSingleByteRange,
      readSource:async ctx=>{
        readerCalls.push(ctx.request.headers.get('Range'));
        const hasRange=ctx.request.headers.has('Range');
        return new Response(hasRange?bytes.slice(0,5):bytes,{
          status:hasRange?206:200,
          headers:{'Content-Type':'video/mp4'}
        });
      }
    });
    function ctx(method='GET',headers={}){
      return {env:{img_r2:r2},request:new Request('https://example.test/s3/disk/vid.mp4',{
        method,headers
      })};
    }
    return {route,ctx,operations,readerCalls,node:fileNode};
  }
  it('returns 206 and clamps an end offset beyond EOF',async()=>{
    const {route,ctx,operations}=await handler();
    const res=await route.serveObject(ctx('GET',{Range:'bytes=0-500'}),node);
    assert.equal(res.status,206);
    assert.equal(res.headers.get('Content-Range'),'bytes 0-10/11');
    assert.equal(res.headers.get('Content-Length'),'11');
    assert.equal(await res.text(),'hello world');
    assert.deepEqual(operations[0],{range:{offset:0,length:11}});
  });
  it('supports suffix ranges and returns 416 for an unsatisfiable start',async()=>{
    const {route,ctx,operations}=await handler();
    const suffix=await route.serveObject(ctx('GET',{Range:'bytes=-5'}),node);
    assert.equal(suffix.status,206);
    assert.equal(suffix.headers.get('Content-Range'),'bytes 6-10/11');
    assert.equal(await suffix.text(),'world');
    const invalid=await route.serveObject(ctx('GET',{Range:'bytes=30-'}),node);
    assert.equal(invalid.status,416);
    assert.equal(invalid.headers.get('Content-Range'),'bytes */11');
    assert.equal(operations.length,1,'416 must not fetch file bytes');
  });
  it('on stale If-Range returns complete 200 with an unchanged object ETag',async()=>{
    const {route,ctx,operations}=await handler();
    const res=await route.serveObject(ctx('GET',{
      Range:'bytes=0-4','If-Range':'"obsolete"'
    }),node);
    assert.equal(res.status,200);
    assert.equal(res.headers.get('ETag'),'"12345678-2222-4444-8888-000000000000"');
    assert.equal(await res.text(),'hello world');
    assert.deepEqual(operations,[null]);
  });
  it('HEAD returns length and does not process Range',async()=>{
    const {route,ctx,operations}=await handler();
    const res=await route.serveObject(ctx('HEAD',{Range:'bytes=55-'}),node);
    assert.equal(res.status,200);
    assert.equal(res.headers.get('Content-Length'),'11');
    assert.equal(operations.length,1);
    assert.equal(operations[0],null);
  });
  it('applies virtual ETag If-Range to an existing non-R2 ImgBed reader',async()=>{
    const {route,ctx,readerCalls,node:legacyNode}=await handler({channel:'TelegramNew'});
    const stale=await route.serveObject(ctx('GET',{
      Range:'bytes=0-4','If-Range':'"old-tag"'
    }),legacyNode);
    assert.equal(stale.status,200);
    assert.equal(await stale.text(),'hello world');
    assert.equal(readerCalls[0],null,'stale If-Range must strip Range before provider read');
    const correct=await route.serveObject(ctx('GET',{
      Range:'bytes=0-4','If-Range':'"virtual-node"'
    }),legacyNode);
    assert.equal(correct.status,206);
    assert.equal(await correct.text(),'hello');
    assert.equal(readerCalls[1],'bytes=0-4');
  });
});
