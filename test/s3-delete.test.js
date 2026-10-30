import assert from 'node:assert/strict';
import {parseDeleteObjectsXml} from '../functions/s3/[[path]].js';
describe('S3 DeleteObjects XML',()=>{
  it('parses keys, XML entities and Quiet flag',()=>{
    assert.deepEqual(parseDeleteObjectsXml(
      '<Delete><Object><Key>docs/a&amp;b.txt</Key></Object><Object><Key>二月/a.txt</Key></Object><Quiet>true</Quiet></Delete>'),
      {keys:['docs/a&b.txt','二月/a.txt'],quiet:true});
  });
  it('rejects malformed keys and unsupported XML',()=>{
    for(const input of ['<Delete></Delete>',
      '<Delete><Object><Key>x&unknown;</Key></Object></Delete>',
      '<Delete><Object><Key>x&broken</Key></Object></Delete>',
      '<Delete><Object><Key>obj</Key><VersionId>1</VersionId></Object></Delete>']){
      assert.throws(()=>parseDeleteObjectsXml(input),input);
    }
  });
});
