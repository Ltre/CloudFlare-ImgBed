/**
 * Read virtual disk objects. Original ImgBed objects stay on its existing
 * channel-aware reader. S3-created R2 objects are private by default:
 * only this function (after disk/share/static authorization) can return
 * their bytes. Ordinary /file URLs remain blocked by ImgBed moderation.
 */
import { onRequest as fileReader } from '../../file/[[path]].js';
import { getDatabase } from '../databaseAdapter.js';
import { parseSingleByteRange } from '../../file/fileTools.js';

async function privateR2Read(context,sourceId,metadata) {
  const {env,request}=context;
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  if(!env.img_r2)return new Response('R2 is not bound',{status:503});
  const r2=env.img_r2;
  const info=typeof r2.head==='function'?await r2.head(sourceId):await r2.get(sourceId);
  if(!info)return new Response('Not Found',{status:404});
  const size=Number(info.size);
  const filename=encodeURIComponent(metadata.FileName||sourceId.split('/').at(-1));
  const headers=new Headers({
    'Content-Type':metadata.FileType||'application/octet-stream',
    'Content-Disposition':`inline; filename*=UTF-8''${filename}`,
    'Cache-Control':'private, no-store, max-age=0',
    'Accept-Ranges':'bytes',
    'X-Content-Type-Options':'nosniff',
    'Content-Length':String(size)
  });
  if(info.httpEtag)headers.set('ETag',info.httpEtag);
  if(request.method==='HEAD'){
    if(info.body && typeof info.body.cancel==='function')await info.body.cancel();
    return new Response(null,{status:200,headers});
  }
  let range=request.headers.get('Range');
  if(range && request.headers.get('If-Range') && info.httpEtag &&
     request.headers.get('If-Range')!==info.httpEtag)range=null;
  let options;
  if(range){
    const span=parseSingleByteRange(range,size);
    if(!span){
      if(info.body && typeof info.body.cancel==='function')await info.body.cancel();
      return new Response(null,{status:416,headers:{
        'Content-Range':'bytes */'+size,'Accept-Ranges':'bytes',
        'Cache-Control':'private, no-store'
      }});
    }
    options={range:{offset:span.start,length:span.end-span.start+1}};
    headers.set('Content-Length',String(span.end-span.start+1));
    headers.set('Content-Range',`bytes ${span.start}-${span.end}/${size}`);
  }
  if(info.body && typeof info.body.cancel==='function')await info.body.cancel();
  const object=await r2.get(sourceId,options);
  if(!object)return new Response('Not Found',{status:404});
  return new Response(object.body,{status:range?206:200,headers});
}

export async function readSource(context, sourceId, privateCache = false) {
  if (sourceId.startsWith('disk-s3/')) {
    const record=await getDatabase(context.env).getWithMetadata(sourceId);
    if(record?.metadata?.DiskS3Private===true && record.metadata.Channel==='CloudflareR2')
      return privateR2Read(context,sourceId,record.metadata);
  }
  const url=new URL('/file/'+sourceId.split('/').map(encodeURIComponent).join('/'),context.request.url);
  const request=new Request(url.toString(),context.request);
  const response=await fileReader({...context,request,params:{path:sourceId.split('/')}});
  if(!privateCache)return response;
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','private, no-store, max-age=0');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
