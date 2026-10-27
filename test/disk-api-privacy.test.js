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
});
