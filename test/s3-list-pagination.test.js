import assert from 'node:assert/strict';
import {loadFunction} from './helpers/loadFunction.js';

describe('S3 ListObjects pagination with directory delimiter',()=>{
  const timestamp=Date.parse('2026-10-27T00:00:00Z');
  const nodes=[
    {id:'folder-a',parent_id:null,name:'a',kind:'directory'},
    {id:'a-1',parent_id:'folder-a',name:'one.txt',kind:'file',size:1,updated_at:timestamp},
    {id:'a-2',parent_id:'folder-a',name:'two.txt',kind:'file',size:2,updated_at:timestamp},
    {id:'folder-b',parent_id:null,name:'b',kind:'directory'},
    {id:'b-1',parent_id:'folder-b',name:'three.txt',kind:'file',size:3,updated_at:timestamp},
    {id:'top-1',parent_id:null,name:'root.txt',kind:'file',size:4,updated_at:timestamp}
  ];
  let api;
  before(async()=>{
    api=await loadFunction('functions/s3/[[path]].js',{
      all:async(_db,sql,space)=>{
        assert.match(sql,/SELECT \* FROM disk_nodes/);
        assert.equal(space,'disk');
        return nodes;
      }
    });
  });
  async function listing(query={}){
    const url=new URL('https://local.test/s3/disk');
    for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
    return api.listBucket({},'disk',url);
  }
  const keys=xml=>Array.from(xml.matchAll(/<Contents><Key>([^<]+)<\/Key>/g),m=>m[1]);
  const prefixes=xml=>Array.from(xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix>/g),m=>m[1]);
  const next=(xml,kind='NextContinuationToken')=>xml.match(new RegExp('<'+kind+'>([^<]+)</'+kind+'>'))?.[1]||null;

  it('paginates visible common prefixes exactly once across V2 pages',async()=>{
    let marker='',seen=[],pages=0;
    do {
      const xml=await listing({'list-type':'2',delimiter:'/', 'max-keys':'1',
        ...(marker?{'continuation-token':marker}:{})});
      const found=[...keys(xml),...prefixes(xml)];
      assert.equal(found.length,1);
      seen.push(found[0]);
      marker=next(xml);
      pages++;
      assert.ok(pages<=4,'a repeated CommonPrefixes would cause excessive pages');
    } while(marker);
    assert.deepEqual(seen,['a/','b/','root.txt']);
  });
  it('uses S3 V1 marker without repeating a directory on the next page',async()=>{
    const first=await listing({delimiter:'/', 'max-keys':'1'});
    assert.deepEqual(prefixes(first),['a/']);
    const nextMarker=next(first,'NextMarker');
    assert.equal(nextMarker,'a/');
    const second=await listing({delimiter:'/', 'max-keys':'1',marker:nextMarker});
    assert.deepEqual(prefixes(second),['b/']);
  });
  it('supports V2 start-after and prefix-only listings',async()=>{
    const page=await listing({'list-type':'2',prefix:'a/', 'start-after':'a/one.txt'});
    assert.deepEqual(keys(page),['a/two.txt']);
    assert.deepEqual(prefixes(page),[]);
    assert.match(page,/<IsTruncated>false<\/IsTruncated>/);
  });
  it('uses physical filenames when delimiter is omitted',async()=>{
    const page=await listing({'list-type':'2','max-keys':'2'});
    assert.deepEqual(keys(page),['a/one.txt','a/two.txt']);
    assert.match(page,/<KeyCount>2<\/KeyCount>/);
    assert.equal(next(page),'a/two.txt');
  });
  it('allows zero max-keys but rejects negative or invalid values',async()=>{
    const zero=await listing({'list-type':'2','max-keys':'0'});
    assert.match(zero,/<KeyCount>0<\/KeyCount>/);
    assert.deepEqual(keys(zero),[]);
    for(const max of ['-1','NaN','1.5']){
      const res=await listing({'list-type':'2','max-keys':max});
      assert.equal(res.status,400,'max-keys='+max);
    }
  });
});
