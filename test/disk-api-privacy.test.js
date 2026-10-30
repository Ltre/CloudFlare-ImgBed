import assert from 'node:assert/strict';
import {loadFunction} from './helpers/loadFunction.js';
describe('disk API capability privacy',()=>{
 const endpoint='https://local.test/api/disk/browse?space=disk1&path=';
 async function browse(kind){
   const api=await loadFunction('functions/api/disk/[[path]].js',{
     requireDiskDb:()=>({}),
     access:async()=>({kind,role:kind==='admin'?'write':'read'}),
     list:async()=>({
       path:'',entries:[{id:'virtual-1',name:'private.txt',kind:'file',
         source_id:'disk-s3/physical-secret',size:42,mime:'text/plain'}],
       breadcrumbs:[{name:'root',path:''}]
     }),
     respond:(data,status=200)=>Response.json(data,{status})
   });
   const context={request:new Request(endpoint),params:{path:['browse']},env:{}};
   const response=await api.onRequest(context);
   assert.equal(response.status,200);
   return response.json();
 }
 it('does not disclose physical source IDs to read-grant collaborators',async()=>{
   const data=await browse('grant');
   assert.equal(data.entries[0].source_id,undefined);
   assert.equal(data.entries[0].name,'private.txt');
   assert.equal(JSON.stringify(data).includes('physical-secret'),false);
 });
 it('retains source IDs for authenticated administrators',async()=>{
   const data=await browse('admin');
   assert.equal(data.entries[0].source_id,'disk-s3/physical-secret');
 });
 async function mutation(action,kind){
   const physical='disk-s3/physical-secret';
   const node={id:'virtual-1',space_id:'disk1',name:'private.txt',kind:'file',
     source_id:physical,mime:'text/plain',size:42};
   const api=await loadFunction('functions/api/disk/[[path]].js',{
     requireDiskDb:()=>({}),
     access:async()=>({kind,role:'write'}),
     renameNode:async()=>node,
     publicNode:async()=>node,
     linkFile:async()=>node,
     mkdir:async()=>({...node,kind:'directory',source_id:null}),
     respond:(value,status=200)=>Response.json(value,{status})
   });
   const body={space:'disk1',path:'',sourceId:physical,name:'new.txt',enabled:true};
   const response=await api.onRequest({
     request:new Request('https://local.test/api/disk/'+action,{
       method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
     }),
     params:{path:[action]},env:{}
   });
   assert.ok(response.ok,'POST '+action+' HTTP '+response.status);
   return response.json();
 }
 for(const action of ['import','rename','public']){
   it('redacts source_id for collaborators after '+action,async()=>{
     const data=await mutation(action,'grant');
     assert.equal(data.node.source_id,undefined);
     assert.equal(data.node.id,'virtual-1');
     assert.ok(!JSON.stringify(data).includes('physical-secret'));
   });
   it('keeps administrative source_id after '+action,async()=>{
     const data=await mutation(action,'admin');
     assert.equal(data.node.source_id,'disk-s3/physical-secret');
   });
 }
});
