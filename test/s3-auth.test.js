import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {verifyS3,allowedS3Origin} from '../functions/s3/[[path]].js';
const hex=s=>createHash('sha256').update(s).digest('hex');
const hmac=(k,v)=>createHmac('sha256',k).update(v).digest();
const key='test-access',secret='test-secret-value',region='auto';
const env={DISK_S3_ACCESS_KEY:key,DISK_S3_SECRET_KEY:secret};
function timestamp(){
  return new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
}
function sign(reqDate,method,path,query='',signedHeaders='host;x-amz-date',payload=hex('')){
  const day=reqDate.slice(0,8),scope=day+'/'+region+'/s3/aws4_request';
  const url=new URL('https://storage.example.test'+path+(query?'?'+query:''));
  const pairs=signedHeaders.split(';').map(k=>k+':'+(k==='host'?url.host:reqDate));
  const canonical=[method,url.pathname,url.searchParams.toString().replace(/\+/g,'%20'),pairs.join('\n')+'\n',signedHeaders,payload].join('\n');
  const toSign='AWS4-HMAC-SHA256\n'+reqDate+'\n'+scope+'\n'+hex(canonical);
  let k=hmac('AWS4'+secret,day);k=hmac(k,region);k=hmac(k,'s3');k=hmac(k,'aws4_request');
  return {signature:createHmac('sha256',k).update(toSign).digest('hex'),scope};
}
describe('S3 SigV4 interoperability and CORS',()=>{
  it('accepts a correctly signed canonical GET and denies tampering',async()=>{
    const date=timestamp(),path='/s3/disk/object.txt';
    const {signature,scope}=sign(date,'GET',path);
    const auth='AWS4-HMAC-SHA256 Credential='+key+'/'+scope+
      ', SignedHeaders=host;x-amz-date, Signature='+signature;
    const headers={Authorization:auth,'x-amz-date':date};
    assert.equal(await verifyS3(new Request('https://storage.example.test'+path,{headers}),env),true);
    assert.equal(await verifyS3(new Request('https://storage.example.test'+path+'-tampered',{headers}),env),false);
    assert.equal(await verifyS3(new Request('https://storage.example.test'+path,{headers}),
      {...env,DISK_S3_SECRET_KEY:'changed'}),false);
  });
  it('refuses an unsigned x-amz-copy-source even when destination signature is valid',async()=>{
    const date=timestamp(),path='/s3/disk/destination.txt';
    const {signature,scope}=sign(date,'PUT',path);
    const auth='AWS4-HMAC-SHA256 Credential='+key+'/'+scope+
      ', SignedHeaders=host;x-amz-date, Signature='+signature;
    const request=new Request('https://storage.example.test'+path,{
      method:'PUT',headers:{Authorization:auth,'x-amz-date':date,
        'x-amz-copy-source':'/disk/sensitive-source.txt'}
    });
    assert.equal(await verifyS3(request,env),false);
  });
  it('rejects malformed signature, expired and missing credentials',async()=>{
    assert.equal(await verifyS3(new Request('https://storage.example.test/s3/disk/file'),env),false);
    assert.equal(await verifyS3(new Request('https://storage.example.test/s3/disk/file',{
      headers:{Authorization:'AWS4-HMAC-SHA256 Credential=abc', 'x-amz-date':'20200101T000000Z'}}),env),false);
  });
  it('permits only same-origin or configured CORS origins',()=>{
    const a=new Request('https://storage.example.test/s3/disk',{
      headers:{Origin:'https://storage.example.test'}});
    const b=new Request('https://storage.example.test/s3/disk',{
      headers:{Origin:'https://app.example.test'}});
    assert.equal(allowedS3Origin(a,env),'https://storage.example.test');
    assert.equal(allowedS3Origin(b,env),'');
    assert.equal(allowedS3Origin(b,{...env,DISK_S3_CORS_ORIGINS:'https://app.example.test'}),'https://app.example.test');
  });
});
