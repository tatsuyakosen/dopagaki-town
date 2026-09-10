import { handleRequest } from "../apps/city-builder/src/worker.js";

const emit=(message:unknown)=>process.stdout.write(`${JSON.stringify(message)}\n`);
try{
  const chunks:Buffer[]=[];let size=0;
  for await(const raw of process.stdin){const chunk=raw as Buffer;size+=chunk.length;if(size>65536)throw new Error("REQUEST_TOO_LARGE");chunks.push(chunk);}
  const result=await handleRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,value=>{emit({event:"progress",...value});});
  emit({event:"result",value:result});
}catch(error){
  const message=error instanceof Error?error.message:"";
  emit({event:"error",code:/^[A-Z_]{3,60}$/.test(message)?message:"SOURCE_OR_GEOMETRY_UNSUPPORTED"});
  process.exitCode=1;
}
