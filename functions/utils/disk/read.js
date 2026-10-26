/**
 * Invoke ImgBed's existing file reader directly, without a self-fetch,
 * external redirect or new upload protocol. This preserves Telegram/Discord
 * chunk assembly, R2/S3/WebDAV range handling and blacklist policy.
 */
import { onRequest as fileReader } from '../../file/[[path]].js';

export async function readSource(context, sourceId, privateCache = false) {
  const url = new URL('/file/' + sourceId.split('/').map(encodeURIComponent).join('/'),context.request.url);
  const request = new Request(url.toString(), context.request);
  const response = await fileReader({
    ...context,
    request,
    params: { path: sourceId.split('/') },
  });
  if (!privateCache) return response;
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','private, no-store, max-age=0');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
