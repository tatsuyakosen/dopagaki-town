import type { IncomingMessage, ServerResponse } from "node:http";
import { SelectionSchema, BuildRequestSchema } from "./contracts.js";
import { CityBuilder, readStage } from "./service.js";

export function allowedWrite(req:Pick<IncomingMessage,"headers">):boolean {
  if(req.headers["x-city-client"]!=="1")return false;
  const origin=req.headers.origin;if(!origin)return true;
  try{return new URL(origin).host===req.headers.host;}catch{return false;}
}
async function body(req:IncomingMessage):Promise<unknown>{
  let text="";for await(const chunk of req){text+=String(chunk);if(Buffer.byteLength(text)>1024)throw new Error("BAD_REQUEST");}
  return JSON.parse(text) as unknown;
}
export function createCityHandler(builder=new CityBuilder()):(req:IncomingMessage,res:ServerResponse,next:()=>void)=>void {
  return (req,res,next)=>{
    const url=new URL(req.url??"/","http://city.local");
    if(!url.pathname.startsWith("/api/city/")){next();return;}
    res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
    const send=(status:number,data:unknown)=>{if(res.destroyed||res.writableEnded)return;res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(data));};
    if(req.method!=="GET" && !allowedWrite(req)){send(403,{code:"ORIGIN_REJECTED"});return;}
    void (async()=>{
      if(req.method==="GET" && url.pathname==="/api/city/status"){send(200,builder.status());return;}
      if(req.method==="POST" && url.pathname==="/api/city/ready"){
        const request=SelectionSchema.extend({quality:BuildRequestSchema.shape.quality}).parse(await body(req));
        send(200,{ready:await builder.ready(request.latitude,request.longitude,request.quality)});return;
      }
      if(req.method==="POST" && url.pathname==="/api/city/catalog"){
        const controller=new AbortController();res.once("close",()=>{if(!res.writableEnded)controller.abort();});
        const area=SelectionSchema.parse(await body(req));const {id,catalog}=await builder.discover(area.latitude,area.longitude,controller.signal);
        send(200,{id,city:catalog.city,year:catalog.year,license:catalog.license,sourceBytes:catalog.files.reduce((n,f)=>n+f.bytes,0),files:catalog.files.length,planner:builder.status().planner});return;
      }
      if(req.method==="POST" && url.pathname==="/api/city/jobs"){
        const request=BuildRequestSchema.parse(await body(req));send(202,builder.start(request.catalogId,request.quality,request.tile));return;
      }
      const jobMatch=/^\/api\/city\/jobs\/([a-f0-9]{24})$/.exec(url.pathname);
      if(jobMatch && (req.method==="GET" || req.method==="DELETE")){
        const job=builder.get(jobMatch[1]!);if(!job){send(404,{code:"NOT_FOUND"});return;}
        if(req.method==="DELETE")builder.cancel(job.id);send(200,job);return;
      }
      const stage=/^\/api\/city\/stages\/([a-f0-9]{24})$/.exec(url.pathname);
      if(req.method==="GET" && stage){
        const compressed=/(?:^|[,\s])gzip(?:[,\s]|$)/.test(req.headers["accept-encoding"]??"");
        const data=await readStage(stage[1]!,compressed);res.setHeader("Content-Type","application/json; charset=utf-8");
        res.setHeader("Vary","Accept-Encoding");res.setHeader("Cache-Control","private, max-age=86400, immutable");
        if(compressed)res.setHeader("Content-Encoding","gzip");res.setHeader("Content-Length",data.length);res.end(data);return;
      }
      send(404,{code:"NOT_FOUND"});
    })().catch((error:unknown)=>{const message=error instanceof Error?error.message:"BAD_REQUEST";const code=/^[A-Z_]{3,60}$/.test(message)?message:"BAD_REQUEST";send(code==="BUSY"?429:400,{code});});
  };
}
