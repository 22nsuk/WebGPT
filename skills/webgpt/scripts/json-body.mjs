const MAX_DEPTH=64,MAX_STRUCTURE=65536,MAX_READERS=4,BLOCK_BYTES=64*1024;
const tooLarge=()=>Object.assign(Error('request too large'),{statusCode:413});
const busy=()=>Object.assign(Error('request body capacity exhausted'),{statusCode:503,code:'HTTP_BODY_BUSY'});

// One reader owns one listener's budget. Keep MCP and authenticated controller
// admission independent, so incomplete MCP bodies cannot occupy controller slots.
export function createJsonBodyReader(limit=2*1024*1024){
  if(!Number.isSafeInteger(limit)||limit<1||limit>128*1024*1024)throw RangeError('invalid JSON body limit');
  let readers=0,buffered=0;
  return async req=>{
    // A declared length is only an early refusal, never allocation authority.
    if(Number(req.headers['content-length'])>limit)throw tooLarge();
    if(readers>=MAX_READERS)throw busy();
    readers++;
    let bytes=0,reserved=0,used=0,depth=0,structure=0,inString=false,escaped=false;
    const blocks=[];
    try{
      // Keep the socket usable for a bounded error response on early refusal.
      // The HTTP handler closes incomplete requests instead of draining them.
      for await(const chunk of req.iterator({destroyOnReturn:false})){
        bytes+=chunk.length;if(bytes>limit)throw tooLarge();
        // ASCII delimiters cannot be hidden inside a valid multibyte UTF-8 code
        // point. Scan before retaining/decoding; strict UTF-8 and JSON grammar
        // validation still happen below. Escapes carry across chunk boundaries.
        for(let i=0;i<chunk.length;i++){
          const c=chunk[i];
          if(inString){
            if(escaped)escaped=false;
            else if(c===0x5c)escaped=true;
            else if(c===0x22)inString=false;
          }else{
            if(c===0x22){inString=true;structure++;}
            else if(c===0x7b||c===0x5b){depth++;structure++;}
            else if(c===0x7d||c===0x5d){
              if(--depth<0)throw SyntaxError('invalid JSON');
              structure++;
            }else if(c===0x2c||c===0x3a)structure++;
            // Count separators and string starts as well as containers: shallow
            // scalar arrays and duplicate object keys also amplify parsed heaps.
            if(depth>MAX_DEPTH||structure>MAX_STRUCTURE)throw tooLarge();
          }
        }
        // Coalesce into bounded pages; tiny HTTP chunks must not create an
        // unbounded array of Buffer wrappers. Charge allocated, not used, bytes.
        for(let offset=0;offset<chunk.length;){
          let block=blocks.at(-1);
          if(!block||used===block.length){
            const size=Math.min(BLOCK_BYTES,limit-reserved);
            if(buffered+size>limit)throw busy();
            block=Buffer.allocUnsafe(size);blocks.push(block);
            buffered+=size;reserved+=size;used=0;
          }
          const count=Math.min(block.length-used,chunk.length-offset);
          chunk.copy(block,used,offset,offset+count);used+=count;offset+=count;
        }
      }
      if(blocks.length)blocks[blocks.length-1]=blocks.at(-1).subarray(0,used);
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(blocks,bytes)));
    }finally{
      buffered-=reserved;readers--;
    }
  };
}
