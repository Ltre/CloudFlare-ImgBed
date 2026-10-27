import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from '../deploy/server/sqliteD1.js';
import {
  DiskError,namePart,pathParts,breadcrumbs,createSpace,mkdir,resolve,list,
  insertNode,transfer,deleteTree,createShare,sharedNode,publicNode,createGrant,
  hashToken,one,uuid,parseGrantTokens
} from '../functions/utils/disk/core.js';

describe('D1 virtual disk, shares and cross-partition operations', () => {
  let db, a, b;
  beforeEach(async () => {
    db=new SqliteD1(':memory:');
    db.exec(readFileSync(new URL('../database/migrations/v2.8.0_disk.sql',import.meta.url),'utf8'));
    a=await createSpace(db,'个人盘');
    b=await createSpace(db,'协同盘');
  });
  afterEach(() => db.db.close());

  it('validates paths and builds breadcrumbs', () => {
    assert.deepEqual(pathParts('文档/2026/一月'),['文档','2026','一月']);
    assert.deepEqual(breadcrumbs('文档/2026').map(c=>c.path),['','文档','文档/2026']);
    for(const path of ['/etc','a/../b','a//b','a\\b','a/']) assert.throws(()=>pathParts(path),DiskError);
    for(const name of ['','.','..','a/b','a\nb']) assert.throws(()=>namePart(name),DiskError);
  });
  it('supports multiple scoped collaboration tokens in one request',()=>{
    const first='a'.repeat(64),second='b'.repeat(64);
    const request={headers:{get:n=>n==='X-Disk-Token'?first+', '+second:null}};
    assert.deepEqual(parseGrantTokens(request),[first,second]);
    assert.throws(()=>parseGrantTokens({headers:{get:n=>n==='X-Disk-Token'?'bad':null}}),{code:'INVALID_DISK_TOKEN'});
  });
  it('persists empty nested folders',async()=>{
    await mkdir(db,a.id,'','2026');
    const docs=await mkdir(db,a.id,'2026','照片');
    assert.equal((await resolve(db,a.id,'2026/照片')).id,docs.id);
    assert.deepEqual((await list(db,a.id,'2026')).entries.map(x=>x.name),['照片']);
    assert.deepEqual((await list(db,a.id,'2026/照片')).entries,[]);
  });
  it('copies a directory subtree without reuploading the original source',async()=>{
    const dir=await mkdir(db,a.id,'','项目');
    await mkdir(db,a.id,'项目','阶段');
    const id=uuid(),now=Date.now();
    await insertNode(db,{id,space_id:a.id,parent_id:dir.id,name:'video.mp4',kind:'file',
      source_id:'telegram/original',mime:'video/mp4',size:200000000,is_public:1,
      created_at:now,updated_at:now});
    const result=await transfer(db,a.id,'项目',b.id,'','copy','镜像');
    assert.equal(result.count,3);
    assert.equal((await resolve(db,b.id,'镜像/video.mp4')).source_id,'telegram/original');
    assert.equal((await resolve(db,b.id,'镜像/video.mp4')).is_public,0);
    assert.equal((await resolve(db,a.id,'项目/video.mp4')).source_id,'telegram/original');
  });
  it('moves virtual references across partitions, without deleting bytes',async()=>{
    await mkdir(db,a.id,'','A');
    await mkdir(db,a.id,'A','B');
    await transfer(db,a.id,'A',b.id,'','move','Moved');
    assert.equal((await resolve(db,b.id,'Moved/B')).kind,'directory');
    await assert.rejects(resolve(db,a.id,'A'),{code:'NODE_NOT_FOUND'});
  });
  it('rejects cycles and duplicate names while preserving originals',async()=>{
    await mkdir(db,a.id,'','A');
    await mkdir(db,a.id,'A','B');
    await assert.rejects(transfer(db,a.id,'A',a.id,'A/B','move'),{code:'CANNOT_MOVE_INTO_SELF'});
    await assert.rejects(transfer(db,a.id,'A',a.id,'A/B','copy'),{code:'CANNOT_MOVE_INTO_SELF'});
    await assert.rejects(mkdir(db,a.id,'','A'),{code:'NAME_CONFLICT'});
    assert.equal((await resolve(db,a.id,'A/B')).kind,'directory');
  });
  it('limits capability links to the shared subtree, hashing tokens',async()=>{
    await mkdir(db,a.id,'','Folder');
    await mkdir(db,a.id,'Folder','Inside');
    await mkdir(db,a.id,'','Outside');
    const share=await createShare(db,a.id,'Folder','test',1);
    assert.equal(share.token.length,64);
    assert.equal((await sharedNode(db,share.token,'Inside')).node.kind,'directory');
    await assert.rejects(sharedNode(db,share.token,'../Outside'),{code:'INVALID_NAME'});
    await assert.rejects(sharedNode(db,share.token,'Outside'),{code:'NODE_NOT_FOUND'});
    assert.equal((await one(db,'SELECT token_hash FROM disk_shares WHERE id=?',share.id)).token_hash,await hashToken(share.token));
  });
  it('supports constant-query batch deletion of large partitions',async()=>{
    for(let i=0;i<200;i++) {
      await insertNode(db,{id:uuid(),space_id:a.id,parent_id:'',name:'x-'+i,
        kind:'file',source_id:'id-'+i,mime:'text/plain',size:i,
        is_public:0,created_at:1,updated_at:1});
    }
    const deleted=await db.prepare('DELETE FROM disk_nodes WHERE space_id=?').bind(a.id).run();
    assert.equal(deleted.meta.changes,200);
    assert.equal((await one(db,'SELECT COUNT(*) AS count FROM disk_nodes WHERE space_id=?',a.id)).count,0);
  });
  it('creates collaboration grants and opts in to static file exposure',async()=>{
    const grant=await createGrant(db,a.id,'read','Reviewer');
    assert.equal(grant.token.length,64);
    assert.equal((await one(db,'SELECT role FROM disk_grants WHERE id=?',grant.id)).role,'read');
    await mkdir(db,a.id,'','Media');
    const parent=await resolve(db,a.id,'Media');
    await insertNode(db,{id:uuid(),space_id:a.id,parent_id:parent.id,name:'a.mp3',kind:'file',
      source_id:'id-1',mime:'audio/mpeg',size:100,is_public:0,created_at:1,updated_at:1});
    await publicNode(db,a.id,'Media/a.mp3',true);
    assert.equal((await resolve(db,a.id,'Media/a.mp3')).is_public,1);
    assert.equal(await deleteTree(db,parent),2);
  });
});
