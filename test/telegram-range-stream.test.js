import assert from 'node:assert/strict';
import {createTelegramRangeStream} from '../functions/utils/disk/telegramRange.js';

describe('Telegram multipart Range streaming',()=>{
 const chunks=[{index:0,size:5},{index:1,size:5},{index:2,size:5}];
 const encoded=['abcde','fghij','klmno'];
 const make=(start,end,load)=>createTelegramRangeStream(chunks,start,end,
   load|| (async c=>new TextEncoder().encode(encoded[c.index])));
 it('fetches only the targeted chunk for a narrow byte range',async()=>{
   const seen=[];
   const result=await new Response(make(7,8,async c=>{
     seen.push(c.index);return new TextEncoder().encode(encoded[c.index]);
   })).text();
   assert.equal(result,'hi');
   assert.deepEqual(seen,[1]);
 });
 it('streams correctly across chunk boundaries',async()=>{
   assert.equal(await new Response(make(3,12)).text(),'defghijklm');
 });
 it('does not fetch the remaining chunks after cancellation',async()=>{
   let release;const waiting=new Promise(r=>{release=r;});
   const fetched=[];
   const stream=make(0,14,async c=>{
     fetched.push(c.index);
     if(c.index===1)await waiting;
     return new TextEncoder().encode(encoded[c.index]);
   });
   const reader=stream.getReader();
   const first=await reader.read();
   assert.equal(new TextDecoder().decode(first.value),'abcde');
   await reader.cancel();
   release();
   assert.ok(fetched.length<=2,'must not fetch all chunks after cancellation');
 });
 it('rejects incomplete Telegram chunks instead of sending corrupt bytes',async()=>{
   await assert.rejects(
     new Response(make(0,4,async()=>new Uint8Array([65,66]))).arrayBuffer(),
     /Incomplete Telegram chunk/
   );
 });
 it('rejects oversized Telegram chunks rather than silently truncating data',async()=>{
   await assert.rejects(
     new Response(make(0,4,async()=>new Uint8Array(6))).arrayBuffer(),
     /Incomplete Telegram chunk/
   );
 });

});
