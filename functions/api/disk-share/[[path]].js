import { DiskError,requireDiskDb,sharedNode,handleDiskError } from '../../utils/disk/core.js';
import { readSource } from '../../utils/disk/read.js';

/** Public capability share file endpoint: /api/disk-share/<token>/<path> */
export async function onRequest(context) {
  try {
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method Not Allowed',{status:405});
    const parts = Array.isArray(context.params.path) ? context.params.path : String(context.params.path || '').split('/');
    const [token,...rest] = parts;
    const {node} = await sharedNode(requireDiskDb(context.env),token,rest.map(decodeURIComponent).join('/'));
    if (node.kind !== 'file') throw new DiskError('NOT_FILE',400);
    // Respect ImgBed original public access/security checks; no admin bypass.
    return readSource(context,node.source_id,true);
  } catch(e) { return handleDiskError(e); }
}
