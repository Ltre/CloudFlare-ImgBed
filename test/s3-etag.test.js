import assert from 'node:assert/strict';
import {objectEtag} from '../functions/s3/[[path]].js';

describe('S3 opaque ETag interoperability',()=>{
  it('uses physical source identity across copied S3 virtual nodes',()=>{
    const a={id:'virtual-a',source_id:'disk-s3/a1d2d3f4-2222-4444-8888-000000000000'};
    const b={id:'virtual-b',source_id:a.source_id};
    assert.equal(objectEtag(a),'"a1d2d3f4-2222-4444-8888-000000000000"');
    assert.equal(objectEtag(b),objectEtag(a));
  });
  it('changes ETag after overwriting a virtual object with new physical bytes',()=>{
    const a={id:'same-virtual-node',source_id:'disk-s3/11111111-2222-4444-8888-000000000000'};
    const b={...a,source_id:'disk-s3/33333333-2222-4444-8888-000000000000'};
    assert.notEqual(objectEtag(a),objectEtag(b));
  });
  it('uses a stable virtual identity for original ImgBed sources',()=>{
    assert.equal(objectEtag({id:'virtual-a',source_id:'telegram/file-1'}),'"virtual-a"');
  });
});
