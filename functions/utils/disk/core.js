/**
 * Virtual disk metadata backed by Cloudflare D1. Object bytes remain in the
 * existing ImgBed channel; copying does not rewrite Telegram/Discord chunks.
 * No Node.js APIs: the same code runs on Pages Functions and Workers.
 */
import { authenticate, AUTH_SCOPE } from '../auth/authCore.js';
import { fetchSecurityConfig } from '../sysConfig.js';
import { getDatabase } from '../databaseAdapter.js';

export class DiskError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function namePart(value) {
  if (typeof value !== 'string' || !value || value.length > 255 ||
    value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new DiskError('INVALID_NAME');
  }
  return value;
}
export function pathParts(value) {
  if (value === '' || value == null) return [];
  if (typeof value !== 'string' || value.length > 4096 || value.startsWith('/') ||
    value.endsWith('/') || value.includes('\\')) throw new DiskError('INVALID_PATH');
  return value.split('/').map(namePart);
}
export function breadcrumbs(path) {
  const parts = pathParts(path);
  const result = [{ name: '根目录', path: '' }];
  for (let i = 0; i < parts.length; i++) {
    result.push({ name: parts[i], path: parts.slice(0, i + 1).join('/') });
  }
  return result;
}
export function requireDiskDb(env) {
  if (!env.img_d1 || typeof env.img_d1.prepare !== 'function') {
    throw new DiskError('DISK_D1_REQUIRED', 503);
  }
  return env.img_d1;
}
export async function one(db, sql, ...args) {
  return db.prepare(sql).bind(...args).first();
}
export async function all(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).all()).results || [];
}
export async function run(db, sql, ...args) {
  return db.prepare(sql).bind(...args).run();
}
export function uuid() { return crypto.randomUUID(); }
export function issueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashToken(value) {
  const raw = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function parseGrantTokens(request) {
  const header=request.headers.get('X-Disk-Token');
  const raw=header !== null ? header : (request.headers.get('Authorization')||'').replace(/^Bearer /i,'');
  if (!raw) return [];
  const tokens=raw.split(',').map(s=>s.trim());
  if (tokens.length>8 || tokens.some(s=>!/^[0-9a-f]{64}$/i.test(s))) throw new DiskError('INVALID_DISK_TOKEN',401);
  return tokens;
}
export async function adminAllowed(context) {
  // ImgBed normally permits management when administrator auth is unconfigured.
  // Publicly accessible virtual disks/shares must fail closed instead.
  const config=await fetchSecurityConfig(context.env,{throwOnError:true});
  if (!config.auth?.admin?.adminUsername || !config.auth?.admin?.adminPassword) return false;
  const result = await authenticate({
    env: context.env, request: context.request,
    requiredPermission: 'manage', authScope: AUTH_SCOPE.ADMIN
  });
  return result.authorized;
}
export async function access(context, space, role = 'read') {
  const db = requireDiskDb(context.env);
  if (!(await one(db, 'SELECT id FROM disk_spaces WHERE id=?', space))) {
    throw new DiskError('SPACE_NOT_FOUND', 404);
  }
  const explicitKey = context.request.headers.get('X-Disk-Token');
  if (explicitKey === null && await adminAllowed(context)) return { kind: 'admin', role: 'write' };
  for (const token of parseGrantTokens(context.request)) {
    const grant = await one(db,
      'SELECT id,role FROM disk_grants WHERE token_hash=? AND space_id=?', await hashToken(token), space);
    if (grant && (role === 'read' || grant.role === 'write')) return { kind: 'grant', role: grant.role };
  }
  throw new DiskError('DISK_FORBIDDEN', 403);
}
export async function assertAdmin(context) {
  if (!(await adminAllowed(context))) throw new DiskError('ADMIN_REQUIRED', 403);
}
export async function space(db, id) {
  const value = await one(db, 'SELECT * FROM disk_spaces WHERE id=?', id);
  if (!value) throw new DiskError('SPACE_NOT_FOUND', 404);
  return value;
}
export async function resolve(db, spaceId, path, allowRoot = true) {
  let parent = '';
  const parts = pathParts(path);
  if (!parts.length) {
    if (allowRoot) return { id: '', kind: 'directory', name: '根目录', space_id: spaceId };
    throw new DiskError('ROOT_NOT_ALLOWED');
  }
  let node = null;
  for (const part of parts) {
    node = await one(db,
      'SELECT * FROM disk_nodes WHERE space_id=? AND parent_id=? AND name=?',
      spaceId, parent, part);
    if (!node) throw new DiskError('NODE_NOT_FOUND', 404);
    parent = node.id;
  }
  return node;
}
export async function list(db, spaceId, path) {
  const folder = await resolve(db, spaceId, path);
  if (folder.kind !== 'directory') throw new DiskError('NOT_DIRECTORY');
  const entries = await all(db, 'SELECT id,name,kind,source_id,mime,size,is_public,created_at,updated_at FROM disk_nodes WHERE space_id=? AND parent_id=? ORDER BY kind ASC,name COLLATE NOCASE ASC', spaceId, folder.id);
  return { space: await space(db, spaceId), path: path || '', breadcrumbs: breadcrumbs(path),
    folder: { id: folder.id, name: folder.name }, entries };
}
export async function createSpace(db, name) {
  namePart(name);
  const result = { id: uuid(), name, created_at: Date.now() };
  try { await run(db, 'INSERT INTO disk_spaces(id,name,created_at) VALUES(?,?,?)', result.id,result.name,result.created_at); }
  catch (e) { if (/unique|constraint/i.test(String(e))) throw new DiskError('SPACE_NAME_CONFLICT',409); throw e; }
  return result;
}
export async function mkdir(db, spaceId, path, name) {
  namePart(name);
  const parent = await resolve(db, spaceId, path);
  if (parent.kind !== 'directory') throw new DiskError('NOT_DIRECTORY');
  const node = { id: uuid(), space_id: spaceId, parent_id: parent.id,
    name, kind: 'directory', source_id: null, mime: null, size: 0,
    is_public: 0, created_at: Date.now(), updated_at: Date.now() };
  await insertNode(db, node);
  return node;
}
export async function insertNode(db, n) {
  try {
    await run(db, 'INSERT INTO disk_nodes(id,space_id,parent_id,name,kind,source_id,mime,size,is_public,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      n.id,n.space_id,n.parent_id,n.name,n.kind,n.source_id,n.mime,n.size,n.is_public,n.created_at,n.updated_at);
  } catch (e) {
    if (/unique|constraint/i.test(String(e))) throw new DiskError('NAME_CONFLICT', 409);
    throw e;
  }
}
export async function linkFile(env, db, spaceId, path, sourceId, name) {
  if (typeof sourceId !== 'string' || !sourceId || sourceId.startsWith('manage@')) {
    throw new DiskError('INVALID_SOURCE');
  }
  const record = await getDatabase(env).getWithMetadata(sourceId);
  if (!record || !record.metadata) throw new DiskError('SOURCE_NOT_FOUND', 404);
  if (record.metadata.ListType === 'Block' || (record.metadata.Label === 'adult' && record.metadata.ListType !== 'White')) {
    throw new DiskError('SOURCE_BLOCKED', 403);
  }
  const parent = await resolve(db, spaceId, path);
  if (parent.kind !== 'directory') throw new DiskError('NOT_DIRECTORY');
  const n = { id: uuid(), space_id: spaceId, parent_id: parent.id,
    name: namePart(name || record.metadata.FileName || sourceId.split('/').at(-1)),
    kind: 'file', source_id: sourceId,
    mime: record.metadata.FileType || 'application/octet-stream',
    size: Math.max(0, Math.round(Number(record.metadata.FileSizeBytes) || Number(record.metadata.FileSize || 0)*1048576)),
    is_public: 0, created_at: Date.now(), updated_at: Date.now() };
  await insertNode(db, n);
  return n;
}
export async function renameNode(db, spaceId, path, newName) {
  const node = await resolve(db, spaceId, path, false);
  namePart(newName);
  try {
    await run(db, 'UPDATE disk_nodes SET name=?,updated_at=? WHERE id=?', newName,Date.now(),node.id);
  } catch (e) {
    if (/unique|constraint/i.test(String(e))) throw new DiskError('NAME_CONFLICT', 409);
    throw e;
  }
  return { ...node, name: newName };
}
export async function publicNode(db, spaceId, path, enabled) {
  const node = await resolve(db, spaceId, path, false);
  if (node.kind !== 'file') throw new DiskError('NOT_FILE');
  await run(db, 'UPDATE disk_nodes SET is_public=?,updated_at=? WHERE id=?',
    enabled ? 1 : 0, Date.now(), node.id);
  return { ...node, is_public: enabled ? 1 : 0 };
}
export async function deleteTree(db, root) {
  if (!root.id) throw new DiskError('ROOT_NOT_ALLOWED');
  // Recursive delete only touches virtual nodes, never ImgBed source objects.
  const deleted = await all(db, 'WITH RECURSIVE tree(id) AS (SELECT id FROM disk_nodes WHERE id=? UNION ALL SELECT n.id FROM disk_nodes n JOIN tree t ON n.parent_id=t.id) SELECT id FROM tree',root.id);
  // A single statement makes subtree removal atomic in Cloudflare D1.
  await run(db, 'DELETE FROM disk_nodes WHERE id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM disk_nodes WHERE id=? UNION ALL SELECT n.id FROM disk_nodes n JOIN tree t ON n.parent_id=t.id) SELECT id FROM tree)', root.id);
  return deleted.length;
}
export async function transfer(db, sourceSpace, sourcePath, destSpace, destPath, action, targetName) {
  if (!['move','copy'].includes(action)) throw new DiskError('INVALID_OPERATION');
  const root = await resolve(db, sourceSpace, sourcePath, false);
  const target = await resolve(db, destSpace, destPath);
  if (target.kind !== 'directory') throw new DiskError('NOT_DIRECTORY');
  const name = namePart(targetName || root.name);
  if (sourceSpace === destSpace && root.kind === 'directory') {
    const ancestor = await one(db,
      'WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM disk_nodes WHERE id=? UNION ALL SELECT n.id,n.parent_id FROM disk_nodes n JOIN ancestors a ON a.parent_id=n.id) SELECT id FROM ancestors WHERE id=?',target.id,root.id);
    if (ancestor) throw new DiskError('CANNOT_MOVE_INTO_SELF',409);
  }
  // Fail oversized cross-partition trees before creating *any* destination
  // nodes. The prior on-the-fly 2000-node guard could require thousands of
  // compensating deletes, and a partial rollback could leave ghost folders.
  if(root.kind==='directory' && (action==='copy' || sourceSpace!==destSpace)){
    const total=await one(db, `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM disk_nodes WHERE id=?
      UNION
      SELECT child.id FROM disk_nodes child JOIN subtree t ON child.parent_id=t.id
    ) SELECT COUNT(*) AS count FROM subtree`,root.id);
    if(Number(total?.count)>2000)throw new DiskError('TREE_TOO_LARGE',413);
  }
  if (action === 'move' && sourceSpace === destSpace) {
    try {
      await run(db, 'UPDATE disk_nodes SET parent_id=?,name=?,updated_at=? WHERE id=?',
        target.id,name,Date.now(),root.id);
    } catch (e) {
      if (/unique|constraint/i.test(String(e))) throw new DiskError('NAME_CONFLICT', 409);
      throw e;
    }
    return { id: root.id, moved: true, count: 1 };
  }
  const queue = [{ node: root, newParent: target.id, name }];
  const created = [], visited = new Set();
  try {
    while (queue.length) {
      if (created.length >= 2000) throw new DiskError('TREE_TOO_LARGE',413);
      const current = queue.shift(), n = current.node;
      if (visited.has(n.id)) throw new DiskError('TREE_CYCLE');
      visited.add(n.id);
      const id = uuid(), now = Date.now();
      await insertNode(db, { id, space_id: destSpace, parent_id: current.newParent,
        name: current.name, kind: n.kind, source_id: n.source_id,
        mime: n.mime, size: n.size, is_public: 0,
        created_at: now, updated_at: now });
      created.push(id);
      if (n.kind === 'directory') {
        const children = await all(db, 'SELECT * FROM disk_nodes WHERE space_id=? AND parent_id=? ORDER BY id',sourceSpace,n.id);
        for (const child of children) queue.push({ node: child, newParent: id, name: child.name });
      }
    }
    if (action === 'move') await deleteTree(db, root);
  } catch (e) {
    // Never erase source after an incomplete copy.
    for (const id of created.reverse()) {
      try { await run(db,'DELETE FROM disk_nodes WHERE id=?',id); } catch (_) {}
    }
    throw e;
  }
  return { id: created[0], moved: action === 'move', count: created.length };
}
export async function createGrant(db, spaceId, role, label) {
  if (!['read','write'].includes(role)) throw new DiskError('INVALID_ROLE');
  const token = issueToken(), id = uuid();
  await run(db,'INSERT INTO disk_grants(id,space_id,label,role,token_hash,created_at) VALUES(?,?,?,?,?,?)',
    id,spaceId,String(label || '协同成员').slice(0,100),role,await hashToken(token),Date.now());
  return { id, token, role };
}
export async function createShare(db, spaceId, path, label, hours) {
  const node = await resolve(db,spaceId,path,false);
  const token = issueToken(), id = uuid();
  const expiresAt = hours == null ? null : Date.now() + Math.max(1,Math.min(24 * 365,Number(hours) || 1)) * 3600000;
  await run(db,'INSERT INTO disk_shares(id,space_id,node_id,label,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
    id,spaceId,node.id,String(label || node.name).slice(0,100),await hashToken(token),expiresAt,Date.now());
  return { id,token,expiresAt,url:'/disk-share.html?token=' + token };
}
export async function resolveShare(db, token) {
  if (!/^[0-9a-f]{64}$/i.test(token || '')) throw new DiskError('SHARE_NOT_FOUND',404);
  const record = await one(db,'SELECT * FROM disk_shares WHERE token_hash=?',await hashToken(token));
  if (!record || record.revoked_at || (record.expires_at && record.expires_at < Date.now())) {
    throw new DiskError('SHARE_NOT_FOUND',404);
  }
  const node = await one(db,'SELECT * FROM disk_nodes WHERE id=? AND space_id=?',record.node_id,record.space_id);
  if (!node) throw new DiskError('SHARE_NOT_FOUND',404);
  return { record,node };
}
export async function sharedNode(db, token, subpath) {
  const {record,node} = await resolveShare(db,token);
  let target = node;
  for (const part of pathParts(subpath)) {
    if (target.kind !== 'directory') throw new DiskError('NODE_NOT_FOUND',404);
    target = await one(db,'SELECT * FROM disk_nodes WHERE parent_id=? AND space_id=? AND name=?',
      target.id,record.space_id,part);
    if (!target) throw new DiskError('NODE_NOT_FOUND',404);
  }
  return { record, root: node, node: target };
}
export function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type':'application/json;charset=UTF-8','Cache-Control':'private,no-store'
  }});
}
export function handleDiskError(error) {
  if (!(error instanceof DiskError)) console.error('[disk]',error);
  return respond({success:false,error: error instanceof DiskError ? error.code : 'INTERNAL_ERROR'}, error.status || 500);
}
