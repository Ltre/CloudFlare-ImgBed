/**
 * Real Wrangler/Miniflare HTTP smoke test (Pages and Workers).
 * Fresh temporary D1/KV/R2 state, with NO access to production resources.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, rm, copyFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const requested=process.argv.find(x=>x.startsWith('--mode='))?.slice(7)||'both';
const modes=requested==='both'?['pages','workers']:[requested];
if(modes.some(x=>!['pages','workers'].includes(x)))throw Error('Use --mode=pages, --mode=workers or --mode=both');
const exe=resolve(root,'node_modules','.bin',process.platform==='win32'?'wrangler.cmd':'wrangler');
try{await access(exe);}catch{throw Error('Wrangler is not installed: run npm ci');}
const sha=x=>createHash('sha256').update(x).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'};
let running;
function wrangler(args) {
  return spawn(exe,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],
    shell:process.platform==='win32',windowsHide:true});
}
async function command(args) {
  const child=wrangler(args);let logs='';
  for(const stream of [child.stdout,child.stderr])
    stream.on('data',d=>logs=(logs+d.toString()).slice(-10000));
  const exit=await new Promise((ok,fail)=>{child.on('error',fail);child.on('exit',ok);});
  if(exit!==0)throw Error('wrangler '+args.join(' ')+' exited '+exit+'\n'+logs);
}
async function server(args,port) {
  const proc=wrangler(args);running=proc;
  let logs='';
  for(const stream of [proc.stdout,proc.stderr])
    stream.on('data',d=>logs=(logs+d.toString()).slice(-16000));
  for(let i=0;i<160;i++){
    if(proc.exitCode!==null)throw Error('wrangler dev exited\n'+logs);
    try{
      const res=await fetch('http://127.0.0.1:'+port+'/disk.html',{signal:AbortSignal.timeout(1300)});
      if(res.status===200)return proc;
    }catch(_){}
    await pause(500);
  }
  throw Error('wrangler dev startup timeout\n'+logs);
}
function signature(url,method,body,additional={}){
  const date=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const u=new URL(url), payload=sha(body==null?'':body);
  const headers=new Headers(additional);
  headers.set('x-amz-date',date);
  headers.set('x-amz-content-sha256',payload);
  // Sign every x-amz-* header. In particular CopyObject's source must be
  // authenticated: otherwise a valid signed destination can copy arbitrary files.
  const nameList=['host', ...headers.keys()].filter(n=>n==='host'||n.startsWith('x-amz-')).sort();
  const names=nameList.join(';');
  const headerText=nameList.map(n=>n+':'+(n==='host'?u.host:headers.get(n)).trim().replace(/\s+/g,' ')).join('\n')+'\n';
  const pairs=[...u.searchParams].map(([k,v])=>[encodeURIComponent(k),encodeURIComponent(v)])
    .sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
  const canonical=[method,u.pathname,pairs.map(p=>p.join('=')).join('&'),headerText,names,payload].join('\n');
  const day=date.slice(0,8),scope=day+'/auto/s3/aws4_request';
  let k=hmac('AWS4WRANGLER_LOCAL_TEST_SECRET_NEVER_USE_IN_PRODUCTION',day);
  for(const part of ['auto','s3','aws4_request'])k=hmac(k,part);
  const signed=createHmac('sha256',k)
    .update('AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+sha(canonical)).digest('hex');
  headers.set('Authorization','AWS4-HMAC-SHA256 Credential=WRANGLER_LOCAL_TEST_ONLY/'+scope+
    ', SignedHeaders='+names+', Signature='+signed);
  return {method,headers,...(body==null?{}:{body})};
}
async function s3(base,path,method='GET',body=null,headers={}){
  const url=base+'/s3/'+path;return fetch(url,signature(url,method,body,headers));
}
async function json(base,path,{method='GET',token,body,expected=200}={}){
  const headers={};if(token)headers['X-Disk-Token']=token;
  if(body)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();
  assert.equal(response.status,expected,method+' '+path+': HTTP '+response.status+' '+text.slice(0,500));
  return JSON.parse(text);
}
function check(response,status,what){
  assert.equal(response.status,status,what+' returned HTTP '+response.status);
}
async function smoke(base,space,writer,reader){
  const query='?space='+space;
  await json(base,'/api/disk/spaces',{expected:403});
  const spaces=await json(base,'/api/disk/spaces',{token:reader});
  assert.ok(spaces.spaces.some(s=>s.id===space));
  const folder=await json(base,'/api/disk/mkdir',{
    method:'POST',token:writer,body:{space,path:'',name:'docs'}});
  assert.equal(folder.node.name,'docs');
  await json(base,'/api/disk/mkdir',{
    method:'POST',token:reader,body:{space,path:'',name:'denied'},expected:403});
  const info=await json(base,'/api/disk/browse'+query,{token:reader});
  assert.ok(info.entries.some(e=>e.name==='docs'));

  const body=Buffer.from('hello Wrangler, R2, D1 and virtual disk!');
  const objectPath=space+'/docs/a.txt';
  const put=await s3(base,objectPath,'PUT',body,{'Content-Type':'text/plain',
    'Content-Length':String(body.length)});
  check(put,200,'S3 PUT');
  const sourceId='disk-s3/'+String(put.headers.get('ETag')||'').replace(/^"|"$/g,'');
  assert.match(sourceId,/^disk-s3\/[a-f0-9-]{36}$/i);
  await put.arrayBuffer();
  const get=await s3(base,objectPath);check(get,200,'S3 GET');
  assert.equal(await get.text(),body.toString());
  const range=await s3(base,objectPath,'GET',null,{Range:'bytes=0-4'});
  check(range,206,'R2 range');assert.equal(await range.text(),'hello');

  const dir=await json(base,'/api/disk/browse'+query+'&path=docs',{token:reader});
  const file=dir.entries.find(e=>e.name==='a.txt');
  assert.ok(file && !('source_id' in file),'collaborator must not receive physical sourceId');
  const publicRaw=await fetch(base+'/file/'+sourceId);
  assert.notEqual(await publicRaw.text(),body.toString(),'S3 private source leaked');
  check(await fetch(base+'/disk-static/'+space+'/docs/a.txt'),404,'private URL');
  await json(base,'/api/disk/public',{method:'POST',token:writer,
    body:{space,path:'docs/a.txt',enabled:true}});
  const pub=await fetch(base+'/disk-static/'+space+'/docs/a.txt');
  check(pub,200,'public static URL');assert.equal(await pub.text(),body.toString());
  const ticket=await json(base,'/api/disk/shares',{method:'POST',token:writer,
    body:{space,path:'docs/a.txt',label:'local',hours:1}});
  const shared=await fetch(base+'/api/disk-share/'+ticket.share.token);
  check(shared,200,'capability read');assert.equal(await shared.text(),body.toString());

  const copy=await s3(base,space+'/docs/b.txt','PUT',null,{
    'x-amz-copy-source':'/'+space+'/docs/a.txt'});
  check(copy,200,'S3 CopyObject');await copy.arrayBuffer();
  await json(base,'/api/disk/transfer',{method:'POST',token:writer,
    body:{sourceSpace:space,sourcePath:'docs/b.txt',destinationSpace:space,
      destinationPath:'',name:'moved.txt',operation:'move'}});
  const rootView=await json(base,'/api/disk/browse'+query,{token:reader});
  assert.ok(rootView.entries.some(e=>e.name==='moved.txt'));


  // Real Cloudflare R2 multipart operations; non-final part >= 5 MiB.
  const largePath=space+'/docs/multipart.bin';
  const initiate=await s3(base,largePath+'?uploads','POST',null,
    {'Content-Type':'application/octet-stream'});
  check(initiate,200,'S3 CreateMultipartUpload');
  const uploadXml=await initiate.text();
  const uploadId=uploadXml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  assert.ok(uploadId,'missing UploadId: '+uploadXml.slice(0,600));
  const chunk1=Buffer.alloc(5*1024*1024,65),chunk2=Buffer.from('DONE');
  const uploadPart=async(n,bytes)=>{
    const r=await s3(base,largePath+'?partNumber='+n+'&uploadId='+encodeURIComponent(uploadId),
      'PUT',bytes,{'Content-Length':String(bytes.length)});
    check(r,200,'S3 UploadPart '+n);
    const etag=r.headers.get('ETag');assert.ok(etag,'missing part ETag');await r.arrayBuffer();
    return etag;
  };
  const tag1=await uploadPart(1,chunk1),tag2=await uploadPart(2,chunk2);
  const parts=await s3(base,largePath+'?uploadId='+encodeURIComponent(uploadId));
  check(parts,200,'S3 ListParts');
  assert.match(await parts.text(),/<PartNumber>2<\/PartNumber>/);
  const xml='<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>'+tag1+
    '</ETag></Part><Part><PartNumber>2</PartNumber><ETag>'+tag2+
    '</ETag></Part></CompleteMultipartUpload>';
  const completed=await s3(base,largePath+'?uploadId='+encodeURIComponent(uploadId),
    'POST',xml,{'Content-Type':'application/xml','Content-Length':String(Buffer.byteLength(xml))});
  check(completed,200,'S3 CompleteMultipartUpload');await completed.text();
  const tail=await s3(base,largePath,'GET',null,{Range:'bytes=-4'});
  check(tail,206,'multipart suffix Range');
  assert.equal(await tail.text(),'DONE');
  const abortInit=await s3(base,space+'/docs/aborted.bin?uploads','POST',null);
  check(abortInit,200,'S3 initiate to abort');
  const abortId=(await abortInit.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  assert.ok(abortId);
  const aborted=await s3(base,space+'/docs/aborted.bin?uploadId='+encodeURIComponent(abortId),'DELETE');
  check(aborted,204,'S3 AbortMultipartUpload');


  // Regression: the original ImgBed R2 uploader still works, and its optional
  // diskSpace/diskPath hook attaches the same physical file to the virtual disk.
  const form=new FormData();
  form.set('file',new Blob(['imgbed upload integration'],{type:'text/plain'}),'imgbed-native.txt');
  const upload=await fetch(base+'/upload?uploadChannel=cfr2&diskSpace='+space+'&diskPath=docs',{
    method:'POST',headers:{'X-Disk-Token':writer},body:form
  });
  check(upload,200,'original ImgBed upload through R2');
  const uploadData=await upload.json();
  assert.match(String(uploadData[0]?.src||''),/\/file\//);
  let integrated=false;
  for(let i=0;i<25;i++){
    const folder=await json(base,'/api/disk/browse'+query+'&path=docs',{token:reader});
    if(folder.entries.some(e=>e.name==='imgbed-native.txt')){integrated=true;break;}
    await pause(200);
  }
  assert.equal(integrated,true,'ImgBed uploaded object must become a disk reference');

  // Public ImgBed upload permission must never imply virtual disk write.
  const unauthForm=new FormData();
  unauthForm.set('file',new Blob(['no scoped write key'],{type:'text/plain'}),'not-attached.txt');
  const publicUpload=await fetch(base+'/upload?uploadChannel=cfr2&diskSpace='+space+'&diskPath=docs',{
    method:'POST',body:unauthForm
  });
  check(publicUpload,200,'ImgBed standard public upload');
  await publicUpload.text();
  await pause(500);
  const after=await json(base,'/api/disk/browse'+query+'&path=docs',{token:reader});
  assert.equal(after.entries.some(e=>e.name==='not-attached.txt'),false,
    'ImgBed public upload must not create unauthorized disk references');

  const list=await s3(base,space+'?list-type=2');
  check(list,200,'S3 ListObjectsV2');assert.match(await list.text(),/a\.txt/);
  await json(base,'/api/disk/gc',{method:'POST',token:writer,
    body:{confirm:false},expected:403});
  console.log(' PASS: grants, D1 directories, R2 S3 PUT/GET/Range/Copy/List/Multipart/Abort, privacy, share, static and move');
}
async function once(mode){
  const temporary=await mkdtemp(join(tmpdir(),'imgbed-disk-'+mode+'-'));
  const store=join(temporary,'state'),port=mode==='pages'?8789:8790;
  const pagesConfig=join(root,'wrangler.jsonc');
  let installedPagesConfig=false;
  const config=mode==='pages'?'wrangler.disk-local.jsonc':'deploy/worker/wrangler.disk-local.jsonc';
  let proc=null;
  try{
    await mkdir(store,{recursive:true});
    // Pages dev explicitly rejects custom --config paths. Use the standard
    // project-root filename, but refuse to overwrite an existing user config.
    if(mode==='pages'){
      let alreadyExists=false;
      try{await access(pagesConfig);alreadyExists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(alreadyExists)throw Error('Cannot run isolated Pages test: wrangler.jsonc already exists. Do not overwrite user configuration.');
      await copyFile(join(root,'wrangler.disk-local.jsonc'),pagesConfig,0);
      installedPagesConfig=true;
    }
    console.log('Wrangler '+mode+' local test...');
    for(const file of ['v2.8.0_disk.sql','v2.8.1_disk_s3_multipart.sql','v2.8.2_disk_gc.sql'])
      await command(['d1','execute','img_d1','--local','--config',config,
        '--persist-to',store,'--file',join(root,'database/migrations',file)]);
    const space=randomUUID(),writer=randomBytes(32).toString('hex'),
      reader=randomBytes(32).toString('hex');
    const sql="INSERT INTO disk_spaces(id,name,created_at) VALUES('"+space+"','Local Test',"+Date.now()+");\n"+
      "INSERT INTO disk_grants(id,space_id,label,role,token_hash,created_at) VALUES('"+
        randomUUID()+"','"+space+"','writer','write','"+sha(writer)+"',"+Date.now()+");\n"+
      "INSERT INTO disk_grants(id,space_id,label,role,token_hash,created_at) VALUES('"+
        randomUUID()+"','"+space+"','reader','read','"+sha(reader)+"',"+Date.now()+");";
    const fixture=join(temporary,'seed.sql');await writeFile(fixture,sql);
    await command(['d1','execute','img_d1','--local','--config',config,'--persist-to',store,'--file',fixture]);
    const args=mode==='pages'?
      ['pages','dev','frontend-dist','--ip','127.0.0.1','--port',String(port),'--persist-to',store]:
      ['dev','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',store];
    proc=await server(args,port);
    await smoke('http://127.0.0.1:'+port,space,writer,reader);
    console.log('Wrangler '+mode+' PASS');
  }finally{
    proc?.kill();running=null;
    await pause(500);
    if(installedPagesConfig)await unlink(pagesConfig);
    await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
process.on('SIGINT',()=>{running?.kill();process.exit(130);});
process.on('SIGTERM',()=>{running?.kill();process.exit(143);});
async function main(){
  if(modes.includes('workers')){
    const result=spawn(process.execPath,['deploy/worker/generate-routes.js'],{
      cwd:root,env,stdio:'inherit'});
    const status=await new Promise((ok,fail)=>{result.on('error',fail);result.on('exit',ok);});
    assert.equal(status,0,'Workers route generator');
  }
  for(const mode of modes)await once(mode);
  console.log('All local Wrangler modes PASSED');
}
main().catch(error=>{console.error('LOCAL WRANGLER SMOKE FAILED:',error);
  running?.kill();process.exitCode=1;});
