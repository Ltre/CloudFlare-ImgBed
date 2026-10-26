import {
  DiskError, requireDiskDb, one, all, run, respond, handleDiskError,
  adminAllowed, assertAdmin, access, space, list, createSpace, mkdir, linkFile,
  resolve, renameNode, deleteTree, transfer, publicNode, createGrant, createShare,
  sharedNode, resolveShare, hashToken, namePart, issueToken, uuid, parseGrantTokens
} from '../../utils/disk/core.js';

/**
 * Cloudflare Pages + Workers API. Virtual metadata is isolated from ImgBed
 * upload/index paths. POST/DELETE always require administrator or a scoped
 * collaborator write key, never rely on untrusted space/path parameters alone.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const segments = Array.isArray(context.params?.path) ? context.params.path :
    String(context.params?.path || '').split('/').filter(Boolean);
  const action = segments.join('/');
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null,{status:204,headers:{Allow:'GET,HEAD,POST,DELETE,OPTIONS'}});
  try {
    const db = requireDiskDb(env);
    let body = {};
    if (method === 'POST') {
      try { body = await request.json(); } catch (_) { throw new DiskError('INVALID_JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DiskError('INVALID_JSON');
    }
    if (action === 'spaces') {
      if (method === 'GET') {
        const admin = !request.headers.has('X-Disk-Token') && await adminAllowed(context);
        if (admin) return respond({success:true,spaces:await all(db,'SELECT * FROM disk_spaces ORDER BY created_at')});
        const tokens=parseGrantTokens(request);
        if (!tokens.length) throw new DiskError('DISK_FORBIDDEN',403);
        const bySpace=new Map();
        for (const token of tokens) {
          const found = await all(db,'SELECT s.*,g.role FROM disk_spaces s JOIN disk_grants g ON g.space_id=s.id WHERE g.token_hash=?',await hashToken(token));
          for(const s of found) {
            const previous=bySpace.get(s.id);
            if(!previous || (s.role==='write' && previous.role==='read')) bySpace.set(s.id,s);
          }
        }
        if (!bySpace.size) throw new DiskError('DISK_FORBIDDEN',403);
        return respond({success:true,spaces:[...bySpace.values()]});
      }
      if (method === 'POST') {
        await assertAdmin(context);
        const created = await createSpace(db,body.name);
        return respond({success:true,space:created},201);
      }
    }
    if (action === 'space' && method === 'POST') {
      await assertAdmin(context);
      await space(db,body.space);
      if (body.operation === 'rename') {
        const name = String(body.name || '').trim();
        namePart(name);
        await run(db,'UPDATE disk_spaces SET name=? WHERE id=?',name,body.space);
        return respond({success:true});
      }
      if (body.operation === 'delete') {
        const nodes = await all(db,'SELECT id FROM disk_nodes WHERE space_id=?',body.space);
        for (const n of nodes) await run(db,'DELETE FROM disk_nodes WHERE id=?',n.id);
        await run(db,'DELETE FROM disk_grants WHERE space_id=?',body.space);
        await run(db,'DELETE FROM disk_shares WHERE space_id=?',body.space);
        await run(db,'DELETE FROM disk_spaces WHERE id=?',body.space);
        return respond({success:true,deleted:nodes.length});
      }
      throw new DiskError('INVALID_OPERATION');
    }
    if (action === 'browse' && method === 'GET') {
      const s = url.searchParams.get('space'), path = url.searchParams.get('path') || '';
      await access(context,s,'read');
      return respond({success:true,...await list(db,s,path)});
    }
    if (action === 'mkdir' && method === 'POST') {
      await access(context,body.space,'write');
      return respond({success:true,node:await mkdir(db,body.space,body.path || '',body.name)},201);
    }
    if (action === 'import' && method === 'POST') {
      await access(context,body.space,'write');
      return respond({success:true,node:await linkFile(env,db,body.space,body.path || '',body.sourceId,body.name)},201);
    }
    if (action === 'rename' && method === 'POST') {
      await access(context,body.space,'write');
      return respond({success:true,node:await renameNode(db,body.space,body.path,body.name)});
    }
    if (action === 'transfer' && method === 'POST') {
      await access(context,body.sourceSpace,'read');
      await access(context,body.destinationSpace,'write');
      if (body.operation === 'move') await access(context,body.sourceSpace,'write');
      const result = await transfer(db,body.sourceSpace,body.sourcePath,body.destinationSpace,
        body.destinationPath || '',body.operation,body.name);
      return respond({success:true,...result});
    }
    if (action === 'node' && method === 'DELETE') {
      const s = url.searchParams.get('space');
      await access(context,s,'write');
      return respond({success:true,deleted:await deleteTree(db,await resolve(db,s,url.searchParams.get('path'),false))});
    }
    if (action === 'public' && method === 'POST') {
      await access(context,body.space,'write');
      return respond({success:true,node:await publicNode(db,body.space,body.path,body.enabled === true)});
    }
    if (action === 'grants') {
      if (method === 'GET') {
        await assertAdmin(context);
        const s = url.searchParams.get('space');
        await space(db,s);
        return respond({success:true,grants:await all(db,'SELECT id,label,role,created_at FROM disk_grants WHERE space_id=?',s)});
      }
      if (method === 'POST') {
        await assertAdmin(context);
        await space(db,body.space);
        return respond({success:true,grant:await createGrant(db,body.space,body.role,body.label)},201);
      }
      if (method === 'DELETE') {
        await assertAdmin(context);
        const s = url.searchParams.get('space');
        await space(db,s);
        await run(db,'DELETE FROM disk_grants WHERE id=? AND space_id=?',url.searchParams.get('id'),s);
        return respond({success:true});
      }
    }
    if (action === 'shares') {
      if (method === 'GET') {
        const s = url.searchParams.get('space');
        await access(context,s,'read');
        return respond({success:true,shares:await all(db,
          'SELECT id,label,node_id,expires_at,revoked_at,created_at FROM disk_shares WHERE space_id=? ORDER BY created_at DESC',s)});
      }
      if (method === 'POST') {
        await access(context,body.space,'write');
        return respond({success:true,share:await createShare(db,body.space,body.path,body.label,body.hours)},201);
      }
      if (method === 'DELETE') {
        const s = url.searchParams.get('space');
        await access(context,s,'write');
        await run(db,'UPDATE disk_shares SET revoked_at=? WHERE space_id=? AND id=?',Date.now(),s,url.searchParams.get('id'));
        return respond({success:true});
      }
    }
    // Public capability links carry a random 256-bit token whose hash is stored.
    if (action === 'shared' && method === 'GET') {
      const token = url.searchParams.get('token');
      const { node,root } = await sharedNode(db,token,url.searchParams.get('path') || '');
      const entries = node.kind === 'directory'
        ? await all(db,'SELECT name,kind,size,mime FROM disk_nodes WHERE parent_id=? AND space_id=? ORDER BY kind,name',node.id,node.space_id)
        : [];
      return respond({success:true,root:{name:root.name,kind:root.kind},
        node:{name:node.name,kind:node.kind,size:node.size,mime:node.mime},entries});
    }
    if (action === 'preview' && method === 'POST') {
      await access(context,body.space,'read');
      const node=await resolve(db,body.space,body.path,false);
      if (node.kind !== 'file') throw new DiskError('NOT_FILE');
      // Opportunistically remove expired one-time capabilities without cron.
      await run(db,'DELETE FROM disk_shares WHERE expires_at IS NOT NULL AND expires_at < ?',Date.now());
      const token=issueToken(), id=uuid(), expiresAt=Date.now()+300000;
      await run(db,'INSERT INTO disk_shares(id,space_id,node_id,label,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
        id,body.space,node.id,'临时预览',await hashToken(token),expiresAt,Date.now());
      return respond({success:true,url:'/api/disk-share/'+token,expiresAt});
    }
    if (action === 'source' && method === 'GET') {
      const s = url.searchParams.get('space'), path = url.searchParams.get('path');
      const principal=await access(context,s,'read');
      const node = await resolve(db,s,path,false);
      if (node.kind !== 'file') throw new DiskError('NOT_FILE');
      // Read-only collaborators use /preview capability tickets; never disclose
      // the raw ImgBed source ID or privileged from=admin preview route.
      if(principal.kind!=='admin')return respond({success:true,previewRequired:true});
      return respond({success:true,sourceId:node.source_id,
        previewUrl:'/file/' + node.source_id.split('/').map(encodeURIComponent).join('/') + '?from=admin',
        publicUrl:'/disk-static/' + encodeURIComponent(s) + '/' + path.split('/').map(encodeURIComponent).join('/')});
    }
    if (action === 'share-info' && method === 'GET') {
      const {record} = await resolveShare(db,url.searchParams.get('token'));
      return respond({success:true,expiresAt:record.expires_at});
    }
    throw new DiskError('NOT_FOUND',404);
  } catch(e) { return handleDiskError(e); }
}
