/**
 * S3-compatible path-style entry: https://host/s3/<disk-space-id>/<key>
 * AWS SigV4 (header or presigned URL). R2-backed PUT reuses ImgBed metadata,
 * all other object channels are read via ImgBed's existing file endpoint.
 * No npm or Node dependencies; compatible with Cloudflare Pages and Workers.
 */
import {
  requireDiskDb,one,all,run,resolve,mkdir,insertNode,deleteTree,
  DiskError,uuid,handleDiskError
} from '../utils/disk/core.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { addFileToIndex } from '../utils/indexManager.js';

const encoder = new TextEncoder();
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function xml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function esc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function signatureHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
async function hmac(key,value) {
  const raw = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(value)));
}
async function sha256(text) {
  return signatureHex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
}
function s3Error(code,status=400,description='') {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>' + xml(code) +
    '</Code><Message>' + xml(description || code) + '</Message></Error>',
    {status,headers:{'Content-Type':'application/xml','Cache-Control':'no-store'}});
}
function constantEqual(a,b) {
  if (a.length !== b.length) return false;
  let diff=0;
  for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function verifyS3(request,env) {
  const accessKey=env.DISK_S3_ACCESS_KEY, secret=env.DISK_S3_SECRET_KEY;
  if (!accessKey || !secret) return false;
  const url=new URL(request.url), params=url.searchParams;
  const presigned=params.has('X-Amz-Algorithm');
  const auth=request.headers.get('Authorization') || '';
  let credential,signedHeaders,signature,date,expires;
  if (presigned) {
    if (params.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return false;
    credential=params.get('X-Amz-Credential');
    signedHeaders=params.get('X-Amz-SignedHeaders');
    signature=params.get('X-Amz-Signature');
    date=params.get('X-Amz-Date');
    expires=Number(params.get('X-Amz-Expires'));
    if (!Number.isInteger(expires) || expires < 1 || expires > 604800) return false;
  } else {
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) return false;
    const attrs=Object.fromEntries(auth.slice(16).split(',').map(pair=>{
      const i=pair.indexOf('=');
      return [pair.slice(0,i).trim(),pair.slice(i+1).trim()];
    }));
    credential=attrs.Credential; signedHeaders=attrs.SignedHeaders; signature=attrs.Signature;
    date=request.headers.get('x-amz-date');
  }
  if (!credential || !signedHeaders || !/^[0-9a-f]{64}$/i.test(signature || '')) return false;
  const [key,day,region,service,terminator] = credential.split('/');
  if (key !== accessKey || service !== 's3' || terminator !== 'aws4_request' ||
    !/^\d{8}$/.test(day) || !region || !/^\d{8}T\d{6}Z$/.test(date || '') ||
    day !== date.slice(0,8)) return false;
  const moment=Date.parse(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T'+
    date.slice(9,11)+':'+date.slice(11,13)+':'+date.slice(13,15)+'Z');
  if (!Number.isFinite(moment)) return false;
  const delta=(Date.now()-moment)/1000;
  if (presigned ? delta < -900 || delta > expires : Math.abs(delta)>900) return false;

  const names=signedHeaders.split(';');
  if (!names.includes('host') || names.some((n,i)=>!n || n !== n.toLowerCase() ||
     (i>0 && n<=names[i-1]))) return false;
  const canonicalHeaders=[];
  for (const name of names) {
    const value=name==='host' ? url.host : request.headers.get(name);
    if (value == null) return false;
    canonicalHeaders.push(name+':'+value.trim().replace(/\s+/g,' '));
  }
  const query=Array.from(params.entries()).filter(([k])=>!presigned || k!=='X-Amz-Signature')
    .map(([k,v])=>[esc(k),esc(v)]).sort((a,b)=>a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([k,v])=>k+'='+v).join('&');
  const payload=presigned ? 'UNSIGNED-PAYLOAD' :
    (request.headers.get('x-amz-content-sha256') || emptyHash);
  const canonical=[
    request.method.toUpperCase(),url.pathname || '/',query,
    canonicalHeaders.join('\n')+'\n',signedHeaders,payload
  ].join('\n');
  const scope=day+'/'+region+'/s3/aws4_request';
  const stringToSign='AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+await sha256(canonical);
  let k=await hmac('AWS4'+secret,day);
  k=await hmac(k,region);k=await hmac(k,'s3');k=await hmac(k,'aws4_request');
  const expected=signatureHex(await hmac(k,stringToSign));
  return constantEqual(expected,signature.toLowerCase());
}
function pathParam(context) {
  const raw=Array.isArray(context.params?.path) ? context.params.path :
    String(context.params?.path || '').split('/').filter(Boolean);
  return raw.map(part=>decodeURIComponent(part));
}
function xmlResponse(text,status=200,headers={}) {
  return new Response(text,{status,headers:{'Content-Type':'application/xml',...headers}});
}
function objectName(node,key) {
  return {key,size:node.size,mime:node.mime};
}
async function ensureParents(db,spaceId,parts) {
  let prefix='';
  for (const part of parts) {
    let node;
    try { node=await resolve(db,spaceId,prefix ? prefix+'/'+part : part); }
    catch(e) {
      if (e.code !== 'NODE_NOT_FOUND') throw e;
      node=await mkdir(db,spaceId,prefix,part);
    }
    if (node.kind !== 'directory') throw new DiskError('NOT_DIRECTORY',409);
    prefix=prefix ? prefix+'/'+part : part;
  }
}
async function collectObjects(db,bucket) {
  const nodes=await all(db,'SELECT * FROM disk_nodes WHERE space_id=?',bucket);
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const memo=new Map();
  function toPath(n,depth=0) {
    if (memo.has(n.id)) return memo.get(n.id);
    if (depth>100) throw new DiskError('TREE_TOO_DEEP');
    const parent=n.parent_id ? byId.get(n.parent_id) : null;
    if (n.parent_id && !parent) throw new DiskError('BROKEN_PARENT',500);
    const path=(parent?toPath(parent,depth+1)+'/':'')+n.name;
    memo.set(n.id,path);
    return path;
  }
  return nodes.filter(n=>n.kind==='file').map(n=>({node:n,key:toPath(n)}));
}
async function listBucket(db,bucket,url) {
  const prefix=url.searchParams.get('prefix')||'',delimiter=url.searchParams.get('delimiter')||'';
  if (delimiter && delimiter!=='/') return s3Error('InvalidArgument');
  const max=Math.max(1,Math.min(1000,Number(url.searchParams.get('max-keys'))||1000));
  const marker=url.searchParams.get('continuation-token')||url.searchParams.get('marker')||'';
  const items=(await collectObjects(db,bucket)).filter(n=>n.key.startsWith(prefix) && n.key>marker)
    .sort((a,b)=>a.key < b.key ? -1 : 1);
  let returned=0, contents='', prefixes=new Set(), last='';
  for (const item of items) {
    const rest=item.key.slice(prefix.length), slash=delimiter ? rest.indexOf('/') : -1;
    const group=slash>=0 ? prefix+rest.slice(0,slash+1) : null;
    if (group && prefixes.has(group)) continue;
    if (returned>=max) break;
    if (group) {prefixes.add(group);last=item.key;returned++;continue;}
    contents+='<Contents><Key>'+xml(item.key)+'</Key><Size>'+item.node.size+'</Size><LastModified>'+
      new Date(item.node.updated_at).toISOString()+'</LastModified><ETag>"'+xml(item.node.id)+'"</ETag></Contents>';
    last=item.key; returned++;
  }
  const more=items.some(x=>x.key>last) && returned>=max;
  const common=Array.from(prefixes).map(p=>'<CommonPrefixes><Prefix>'+xml(p)+'</Prefix></CommonPrefixes>').join('');
  const v2=url.searchParams.get('list-type')==='2';
  const pagination=more ? (v2?'<NextContinuationToken>':'<NextMarker>')+xml(last)+(v2?'</NextContinuationToken>':'</NextMarker>') : '';
  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'+
    '<Name>'+xml(bucket)+'</Name><Prefix>'+xml(prefix)+'</Prefix><KeyCount>'+returned+'</KeyCount><MaxKeys>'+max+
    '</MaxKeys><IsTruncated>'+String(more)+'</IsTruncated>'+contents+common+pagination+'</ListBucketResult>');
}
async function serveObject(context,node) {
  const {env,request}=context;
  const record=await getDatabase(env).getWithMetadata(node.source_id);
  if (!record) return s3Error('NoSuchKey',404);
  if (record.metadata?.ListType==='Block' || (record.metadata?.Label==='adult' && record.metadata?.ListType!=='White')) {
    return s3Error('AccessDenied',403);
  }
  const type=node.mime || 'application/octet-stream';
  const headers=new Headers({'Content-Type':type,'Accept-Ranges':'bytes',
    'Content-Disposition':'inline; filename*=UTF-8\'\''+encodeURIComponent(node.name)});
  if (record.metadata?.Channel !== 'CloudflareR2') {
    // Non-R2 providers retain the original ImgBed streaming/chunk handling.
    // This path uses an HTTP redirect and requires following redirects.
    const target=new URL('/file/'+node.source_id.split('/').map(encodeURIComponent).join('/'),request.url);
    return Response.redirect(target.toString(),307);
  }
  const bucket=env.img_r2;
  if (!bucket) return s3Error('ServiceUnavailable',503);
  const range=request.headers.get('Range');
  let options,begin,end;
  const size=Math.max(0,Number(node.size)||0);
  if (range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) return s3Error('InvalidRange',416);
    if (m[1]) { begin=Number(m[1]);end=m[2]?Number(m[2]):size-1; }
    else { begin=Math.max(0,size-Number(m[2]));end=size-1; }
    if (!size || begin>=size || end<begin || end>=size) {
      return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
    }
    options={range:{offset:begin,length:end-begin+1}};
  }
  const object=await bucket.get(node.source_id,options);
  if (!object) return s3Error('NoSuchKey',404);
  if (!range) headers.set('Content-Length',String(object.size));
  else {
    headers.set('Content-Range','bytes '+begin+'-'+end+'/'+object.size);
    headers.set('Content-Length',String(end-begin+1));
  }
  if (request.method==='HEAD') {
    try { await object.body?.cancel(); } catch (_) {}
    return new Response(null,{status:200,headers});
  }
  return new Response(object.body,{status:range?206:200,headers});
}
export async function onRequest(context) {
  const {request,env}=context;
  try {
    if (!(await verifyS3(request,env))) return s3Error('SignatureDoesNotMatch',403);
    const db=requireDiskDb(env), parts=pathParam(context),bucket=parts.shift();
    const method=request.method, url=new URL(request.url);
    if (!bucket) {
      if (method!=='GET') return s3Error('MethodNotAllowed',405);
      const spaces=await all(db,'SELECT id,created_at FROM disk_spaces ORDER BY created_at');
      return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets>'+
        spaces.map(s=>'<Bucket><Name>'+xml(s.id)+'</Name><CreationDate>'+
          new Date(s.created_at).toISOString()+'</CreationDate></Bucket>').join('')+
        '</Buckets></ListAllMyBucketsResult>');
    }
    if (!(await one(db,'SELECT id FROM disk_spaces WHERE id=?',bucket))) return s3Error('NoSuchBucket',404);
    if (!parts.length) {
      if (method==='HEAD') return new Response(null,{status:200});
      if (method==='GET') return await listBucket(db,bucket,url);
      return s3Error('NotImplemented',501);
    }
    const key=parts.join('/'),dir=parts.slice(0,-1).join('/'),name=parts.at(-1);
    let node=null;
    try {node=await resolve(db,bucket,key,false);}catch(e){if(e.code!=='NODE_NOT_FOUND')throw e;}
    if (method==='GET'||method==='HEAD') {
      if (!node || node.kind!=='file') return s3Error('NoSuchKey',404);
      return serveObject(context,node);
    }
    if (method==='DELETE') {
      if (node) await deleteTree(db,node);
      return new Response(null,{status:204});
    }
    if (method==='PUT' && request.headers.has('x-amz-copy-source')) {
      if (node) return s3Error('ObjectAlreadyExists',409);
      const copyPath=decodeURIComponent(request.headers.get('x-amz-copy-source')).replace(/^\//,'');
      const idx=copyPath.indexOf('/');
      if (idx<0) return s3Error('InvalidArgument');
      const sourceBucket=copyPath.slice(0,idx), sourceKey=copyPath.slice(idx+1).split('?')[0];
      if (!(await one(db,'SELECT id FROM disk_spaces WHERE id=?',sourceBucket))) return s3Error('NoSuchBucket',404);
      const source=await resolve(db,sourceBucket,sourceKey,false);
      if (source.kind!=='file') return s3Error('NoSuchKey',404);
      await ensureParents(db,bucket,parts.slice(0,-1));
      const now=Date.now(),parent=await resolve(db,bucket,dir);
      await insertNode(db,{id:uuid(),space_id:bucket,parent_id:parent.id,name,kind:'file',
        source_id:source.source_id,mime:source.mime,size:source.size,is_public:0,created_at:now,updated_at:now});
      return xmlResponse('<CopyObjectResult><LastModified>'+new Date(now).toISOString()+'</LastModified></CopyObjectResult>');
    }
    if (method==='PUT') {
      if (!env.img_r2) return s3Error('ServiceUnavailable',503,'R2 binding is required for S3 PutObject');
      if (node) return s3Error('ObjectAlreadyExists',409);
      if (!request.body) return s3Error('InvalidRequest');
      const fileId='disk-s3/'+uuid(),contentType=request.headers.get('Content-Type')||'application/octet-stream';
      const contentLength=Number(request.headers.get('Content-Length'));
      if (!Number.isSafeInteger(contentLength) || contentLength<0) return s3Error('MissingContentLength',411);
      await ensureParents(db,bucket,parts.slice(0,-1));
      const parent=await resolve(db,bucket,dir);
      await env.img_r2.put(fileId,request.body,{httpMetadata:{contentType}});
      const metadata={Channel:'CloudflareR2',FileName:name,FileType:contentType,
        FileSize:String(contentLength),TimeStamp:Date.now(),Directory:'disk-s3/',ListType:'None'};
      try {
        await getDatabase(env).put(fileId,'',{metadata});
        await insertNode(db,{id:uuid(),space_id:bucket,parent_id:parent.id,name,
          kind:'file',source_id:fileId,mime:contentType,size:contentLength,is_public:0,
          created_at:Date.now(),updated_at:Date.now()});
      }catch(e) { await env.img_r2.delete(fileId);throw e; }
      if (context.waitUntil) context.waitUntil(addFileToIndex(context,fileId,metadata));
      return new Response(null,{status:200,headers:{ETag:'"'+fileId.split('/')[1]+'"'}});
    }
    return s3Error('NotImplemented',501);
  }catch(e) {
    if (e instanceof DiskError) {
      const map={NAME_CONFLICT:'ObjectAlreadyExists',NODE_NOT_FOUND:'NoSuchKey',
        INVALID_PATH:'InvalidObjectName',INVALID_NAME:'InvalidObjectName'};
      return s3Error(map[e.code]||e.code,e.status);
    }
    console.error('[s3]',e);
    return s3Error('InternalError',500);
  }
}
