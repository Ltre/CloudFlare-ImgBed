import assert from 'node:assert/strict';
import {loadFunction, memoryDatabase} from './helpers/loadFunction.js';
import {parseSingleByteRange} from '../functions/file/fileTools.js';

describe('S3 byte-range / If-Range response semantics',()=>{
  const bytes=new TextEncoder().encode('hello world');
  const sourceId='disk-s3/12345678-2222-4444-8888-000000000000';
  const node={id:'virtual-node',source_id:sourceId,name:'video.mp4',
    mime:'video/mp4',size:bytes.length,updated_at:Date.parse('2026-10-28T15:00:00Z')};
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
        readerCalls.push({
          range:ctx.request.headers.get('Range'),
          ifRange:ctx.request.headers.get('If-Range')
        });
        // Telegram's own reader has an independent ETag, so a virtual S3
        // If-Range passed through directly would incorrectly return full 200.
        const providerEtag='"telegram-native-etag"';
        const ifRange=ctx.request.headers.get('If-Range');
        const hasRange=ctx.request.headers.has('Range')&&
          (!ifRange || ifRange===providerEtag);
        return new Response(hasRange?bytes.slice(0,5):bytes,{
          status:hasRange?206:200,
          headers:{'Content-Type':'video/mp4','ETag':providerEtag}
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
    assert.deepEqual(readerCalls[0],{range:null,ifRange:null},
      'stale If-Range must not reach provider');
    const correct=await route.serveObject(ctx('GET',{
      Range:'bytes=0-4','If-Range':'"virtual-node"'
    }),legacyNode);
    assert.equal(correct.status,206);
    assert.equal(await correct.text(),'hello');
    assert.deepEqual(readerCalls[1],{range:'bytes=0-4',ifRange:null},
      'matching virtual ETag must not be passed to Telegram ETag validation');
    const head=await route.serveObject(ctx('HEAD',{
      Range:'bytes=0-4','If-Range':'"virtual-node"'
    }),legacyNode);
    assert.equal(head.status,200);
    assert.deepEqual(readerCalls[2],{range:null,ifRange:null});
  });
  it('provides Last-Modified and conditional S3 GET/HEAD semantics without reading bytes',async()=>{
    const {route,ctx,operations}=await handler();
    const etag='"12345678-2222-4444-8888-000000000000"';
    const notChanged=await route.serveObject(ctx('GET',{'If-None-Match':etag}),node);
    assert.equal(notChanged.status,304);
    assert.equal(notChanged.headers.get('ETag'),etag);
    assert.equal(notChanged.headers.get('Last-Modified'),'Wed, 28 Oct 2026 15:00:00 GMT');
    const mismatch=await route.serveObject(ctx('HEAD',{'If-Match':'"some-other-object"'}),node);
    assert.equal(mismatch.status,412);
    const matching=await route.serveObject(ctx('HEAD',{'If-Match':'"another", '+etag}),node);
    assert.equal(matching.status,200);
    assert.deepEqual(operations,[null],
      '304 and 412 must avoid R2 reads, only the successful HEAD may access R2');
  });
  it('applies S3 virtual ETag conditions before calling Telegram reader',async()=>{
    const {route,ctx,readerCalls,node:legacyNode}=await handler({channel:'TelegramNew'});
    const notChanged=await route.serveObject(ctx('GET',{
      'If-None-Match':'"virtual-node"'
    }),legacyNode);
    assert.equal(notChanged.status,304);
    const mismatch=await route.serveObject(ctx('GET',{
      'If-Match':'"different"'
    }),legacyNode);
    assert.equal(mismatch.status,412);
    assert.deepEqual(readerCalls,[],'conditions must not fetch any Telegram data');
  });

});
