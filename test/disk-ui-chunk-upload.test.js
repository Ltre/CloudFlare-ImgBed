import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

describe('disk UI reuses ImgBed chunked upload protocol',()=>{
  class FakeFormData {
    constructor(){this.entries=[];}
    append(k,v){this.entries.push([k,v]);}
    get(k){return this.entries.find(entry=>entry[0]===k)?.[1]??null;}
  }
  const filename=new URL('../frontend-dist/disk.html',import.meta.url);
  const html=readFileSync(filename,'utf8');
  const from=html.indexOf('const UPLOAD_CHUNK_BYTES=');
  const to=html.indexOf('function uploadedSourceId(',from);
  if(from<0||to<0)throw Error('Disk UI upload helpers not found');
  const source=html.slice(from,to);
  function setup({failAt=0}={}){
    const events=[];
    const fakeFetch=async(url,{body})=>{
      const params=Object.fromEntries(new URL(url,'https://local.test').searchParams);
      events.push({params,body});
      if(failAt && events.length===failAt)
        return {ok:false,status:500,text:async()=> 'temporary provider error'};
      return {ok:true,status:200,json:async()=>params.initChunked
        ? {success:true,uploadId:'session-1'}
        : params.merge
          ? [{src:'https://local.test/file/abc'}] : {success:true}};
    };
    const api=new Function('deps','const {FormData,fetch,qs,state,console}=deps;\n'+
      source+'\nreturn {uploadExistingImgBed};')({
      FormData:FakeFormData,fetch:fakeFetch,
      qs:o=>new URLSearchParams(o).toString(),
      state:{key:''},console:{warn:()=>{}}
    });
    return {...api,events};
  }
  const file=size=>({size,name:'video.mp4',type:'video/mp4',
    slice:(a,b)=>({size:b-a})});

  it('splits a large Telegram upload into bounded requests and merges it',async()=>{
    const {uploadExistingImgBed,events}=setup(),progress=[];
    const result=await uploadExistingImgBed(file(18*1048576),'telegram',
      (done,total)=>progress.push([done,total]));
    assert.equal(events.length,5);
    assert.equal(events[0].params.initChunked,'true');
    assert.deepEqual(events.slice(1,4).map(e=>e.body.get('file').size),
      [8*1048576,8*1048576,2*1048576]);
    assert.equal(events[4].params.merge,'true');
    assert.equal(result[0].src,'https://local.test/file/abc');
    assert.deepEqual(progress,[[1,3],[2,3],[3,3]]);
  });
  it('preserves ImgBed simple upload for small files',async()=>{
    const {uploadExistingImgBed,events}=setup();
    await uploadExistingImgBed(file(1048576),'telegram',()=>{});
    assert.equal(events.length,1);
    assert.equal(events[0].params.chunked,undefined);
    assert.equal(events[0].params.returnFormat,'full');
  });
  it('tries ImgBed cleanup after a chunk fails',async()=>{
    const {uploadExistingImgBed,events}=setup({failAt:3});
    await assert.rejects(uploadExistingImgBed(file(18*1048576),'telegram',()=>{}),
      /temporary provider error/);
    assert.ok(events.some(e=>e.params.cleanup==='true'));
  });
  it('rejects unsupported large-file backends before uploading',async()=>{
    const {uploadExistingImgBed,events}=setup();
    await assert.rejects(uploadExistingImgBed(file(18*1048576),'webdav',()=>{}),
      /不支持 ImgBed 分片上传/);
    assert.equal(events.length,0);
  });
});
