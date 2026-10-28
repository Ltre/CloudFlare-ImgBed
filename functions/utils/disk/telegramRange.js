/**
 * Backpressure-aware Telegram multipart reader. Never requests chunks outside
 * the requested byte range and never preloads the entire object into memory.
 * Works in Workers and Pages using standard Web ReadableStream APIs.
 */
export function createTelegramRangeStream(chunks,rangeStart,rangeEnd,loadChunk){
  let index=0,position=0,cancelled=false;
  return new ReadableStream({
    async pull(controller){
      if(cancelled)return;
      while(index<chunks.length){
        const chunk=chunks[index++],size=Number(chunk.size)||0;
        const offset=position;
        position+=size;
        if(position<=rangeStart)continue;
        if(offset>rangeEnd){controller.close();return;}
        try{
          const data=await loadChunk(chunk);
          if(cancelled)return;
          if(!(data instanceof Uint8Array))throw new Error('Telegram chunk unavailable: '+chunk.index);
          const first=Math.max(0,rangeStart-offset);
          const last=Math.min(size,rangeEnd-offset+1);
          if(first<last){
            if(last>data.length)throw new Error('Incomplete Telegram chunk: '+chunk.index);
            controller.enqueue(data.subarray(first,last));
          }
          if(position>rangeEnd || index===chunks.length)controller.close();
          return;
        }catch(error){
          if(!cancelled)controller.error(error);
          return;
        }
      }
      controller.close();
    },
    cancel(){cancelled=true;}
  });
}
