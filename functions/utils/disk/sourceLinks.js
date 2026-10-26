/**
 * Protect ImgBed source objects used by virtual disk nodes.
 * ImgBed itself still supports KV-only deployments.
 */
export async function assertUnlinkedSource(env, sourceId) {
  if (!env.img_d1 || typeof env.img_d1.prepare !== 'function') return;
  const row=await env.img_d1.prepare('SELECT COUNT(*) AS count FROM disk_nodes WHERE kind=? AND source_id=?')
    .bind('file',sourceId).first();
  if (Number(row?.count)>0) throw new Error('DISK_SOURCE_IN_USE');
}
export async function relinkSource(env, oldId, newId) {
  if (!env.img_d1 || typeof env.img_d1.prepare !== 'function' || oldId===newId) return;
  await env.img_d1.prepare('UPDATE disk_nodes SET source_id=?, updated_at=? WHERE kind=? AND source_id=?')
    .bind(newId,Date.now(),'file',oldId).run();
}
