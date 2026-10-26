import assert from 'node:assert/strict';
import {parseSingleByteRange} from '../functions/file/fileTools.js';
describe('streamed disk byte ranges',()=>{
  for(const [input,size,expected] of [
    ['bytes=0-1023',4096,{start:0,end:1023}],
    ['bytes=1024-',4096,{start:1024,end:4095}],
    ['bytes=-100',4096,{start:3996,end:4095}],
    ['bytes=4000-9000',4096,{start:4000,end:4095}],
    ['bytes=-9999',4096,{start:0,end:4095}]
  ]) it(input,()=>assert.deepEqual(parseSingleByteRange(input,size),expected));
  for(const input of ['bytes=-0','bytes=9999999999-','bytes=5-1','bytes=0-1,3-4','bytes=oops']) {
    it('rejects '+input,()=>assert.equal(parseSingleByteRange(input,100),false));
  }
  it('none',()=>assert.equal(parseSingleByteRange(null,100),null));
});
