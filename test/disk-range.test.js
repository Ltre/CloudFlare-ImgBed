import {loadFunction,memoryDatabase} from './helpers/loadFunction.js';
import {createContext} from './helpers/context.js';
import * as fileTools from '../functions/file/fileTools.js';
import * as imageTransform from '../functions/file/imageTransform.js';
import assert from 'node:assert/strict';
import {parseSingleByteRange} from '../functions/file/fileTools.js';
describe('streamed disk byte ranges',()=>{
  for(const [input,size,expected] of [
    ['bytes=0-1023',4096,{start:0,end:1023}],
    ['bytes=1024-',4096,{start:1024,end:4095}],
    ['bytes=-100',4096,{start:3996,end:4095}],
    ['bytes=4000-9000',4096,{start:4000,end:4095}],
    ['bytes=-9999',4096,{start:0,end:4095}]
  ]) it(input,()=>assert.deepEqual(parseSingleByteRange(input,size),expected));
  for(const input of ['bytes=-0','bytes=9999999999-','bytes=5-1','bytes=0-1,3-4','bytes=oops']) {
    it('rejects '+input,()=>assert.equal(parseSingleByteRange(input,100),false));
  }
  it('none',()=>assert.equal(parseSingleByteRange(null,100),null));
});

describe('R2 media range handling via real file route',()=>{
  let db,route;
  beforeEach(async()=>{
    db=memoryDatabase();
    await db.put('movie.mp4','',{metadata:{Channel:'CloudflareR2',FileName:'movie.mp4',FileType:'video/mp4',ListType:'None'}});
    route=await loadFunction('functions/file/[[path]].js',{
      ...fileTools,...imageTransform,getDatabase:()=>db,
      fetchSecurityConfig:async()=>({access:{whiteListMode:false}})
    });
  });
  async function request(method,range=null,ifRange=null) {
    const bytes=new TextEncoder().encode('hello world');
    let reads=0;
    const env={img_r2:{
      async head(){return {size:bytes.length,httpEtag:'"v1"',writeHttpMetadata(){}};},
      async get(id,opts){
        reads++;
        const part=opts?.range
          ? bytes.slice(opts.range.offset,opts.range.offset+opts.range.length)
          : bytes;
        return {body:new Response(part).body,size:bytes.length,
          range:opts?.range,writeHttpMetadata(){}};
      }
    }};
    const headers={};
    if(range)headers.Range=range;
    if(ifRange)headers['If-Range']=ifRange;
    const ctx=createContext('https://test/file/movie.mp4',{params:{path:'movie.mp4'},env});
    ctx.request=new Request(ctx.url,{method,headers});
    const response=await route.onRequest(ctx);
    return {response,reads};
  }
  it('serves suffix ranges and Content-Range without fetching earlier bytes',async()=>{
    const {response,reads}=await request('GET','bytes=-5');
    assert.equal(response.status,206);
    assert.equal(response.headers.get('Content-Range'),'bytes 6-10/11');
    assert.equal(await response.text(),'world');
    assert.equal(reads,1);
  });
  it('returns 416 and resource size for unsatisfiable ranges',async()=>{
    const {response,reads}=await request('GET','bytes=999-');
    assert.equal(response.status,416);
    assert.equal(response.headers.get('Content-Range'),'bytes */11');
    assert.equal(reads,0);
  });
  it('ignores Range when If-Range ETag differs',async()=>{
    const {response}=await request('GET','bytes=0-2','"stale"');
    assert.equal(response.status,200);
    assert.equal(await response.text(),'hello world');
  });
  it('handles HEAD from R2 metadata without streaming contents',async()=>{
    const {response,reads}=await request('HEAD');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Content-Length'),'11');
    assert.equal(reads,0);
  });
});
