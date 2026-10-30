import { DiskError, requireDiskDb, resolve, handleDiskError } from '../utils/disk/core.js';
import { readSource } from '../utils/disk/read.js';

/** Public static file links are opt-in per virtual file, never per partition. */
export async function onRequest(context) {
  try {
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method Not Allowed',{status:405});
    const parts = Array.isArray(context.params.path) ? context.params.path : String(context.params.path || '').split('/');
    const [spaceId,...rest] = parts;
    if (!spaceId || !rest.length) throw new DiskError('NOT_FOUND',404);
    const node = await resolve(requireDiskDb(context.env),spaceId,rest.map(decodeURIComponent).join('/'),false);
    if (node.kind !== 'file' || !node.is_public) throw new DiskError('NOT_FOUND',404);
    return readSource(context,node.source_id,true);
  } catch (e) { return handleDiskError(e); }
}
