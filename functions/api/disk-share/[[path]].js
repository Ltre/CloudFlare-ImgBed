import { DiskError,requireDiskDb,sharedNode,handleDiskError } from '../../utils/disk/core.js';

/** Public capability share file endpoint: /api/disk-share/<token>/<path> */
export async function onRequest(context) {
  try {
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method Not Allowed',{status:405});
    const parts = Array.isArray(context.params.path) ? context.params.path : String(context.params.path || '').split('/');
    const [token,...rest] = parts;
    const {node} = await sharedNode(requireDiskDb(context.env),token,rest.map(decodeURIComponent).join('/'));
    if (node.kind !== 'file') throw new DiskError('NOT_FILE',400);
    const source = node.source_id.split('/').map(encodeURIComponent).join('/');
    // Respect ImgBed original public access/security checks; no admin bypass.
    return Response.redirect(new URL('/file/' + source,context.request.url),302);
  } catch(e) { return handleDiskError(e); }
}
