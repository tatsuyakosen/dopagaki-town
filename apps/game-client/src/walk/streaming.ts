import { CityManifestSchema, type CityManifest } from "../../../../packages/contracts/src/city.js";
import { areaTileAt, tileKey, tileCoordinates, type AreaTile } from "../../../../packages/contracts/src/area.js";
import type { WalkWorld } from "./world.js";
import type { Job } from "../../../city-builder/src/service.js";

type Resident={x:number;z:number;worldKey:string;vertices:number};
export function canEnterTiles(x:number,z:number,ready:ReadonlySet<string>):boolean {
  if(Math.abs(x)>499||Math.abs(z)>499)return false;
  return [[-.6,-.6],[.6,-.6],[-.6,.6],[.6,.6]].every(([dx,dz])=>{const t=areaTileAt(x+dx!,z+dz!);return ready.has(tileKey(t.x,t.z));});
}
export function wantedTiles(x:number,z:number,velocity={x:0,z:0}):{x:number;z:number;distance:number}[]{
  const current=areaTileAt(x,z),result:{x:number;z:number;distance:number}[]=[];
  for(let tx=Math.max(-2,current.x-1);tx<=Math.min(2,current.x+1);tx++)for(let tz=Math.max(-2,current.z-1);tz<=Math.min(2,current.z+1);tz++){
    const dx=Math.max(0,Math.abs(x-tx*250)-125),dz=Math.max(0,Math.abs(z-tz*250)-125);
    const distance=Math.hypot(dx,dz);if(distance<180)result.push({x:tx,z:tz,distance});
  }
  const speed=Math.hypot(velocity.x,velocity.z),lead=Math.min(175,speed*25);
  const px=x+(speed?velocity.x/speed*lead:0),pz=z+(speed?velocity.z/speed*lead:0);
  const priority=(t:{x:number;z:number;distance:number})=>t.distance<3?-1000+t.distance:Math.hypot(Math.max(0,Math.abs(px-t.x*250)-125),Math.max(0,Math.abs(pz-t.z*250)-125))+.15*t.distance;
  return result.sort((a,b)=>priority(a)-priority(b)).slice(0,5);
}

export class AreaStreamer {
  private resident=new Map<string,Resident>();private failed=new Map<string,string>();private pending=false;
  private controller=new AbortController();private timer:ReturnType<typeof setTimeout>|undefined;private jobId="";
  private position={x:0,z:0};private velocity={x:0,z:0};private blocked=false;private loading="";
  private attempts=new Map<string,{count:number;after:number}>();private cacheHits=0;private builtBlocks=0;
  constructor(private initial:CityManifest,private world:WalkWorld,private quality:"low"|"balanced",
    private notify:(text:string)=>void,private changed:(manifest:CityManifest)=>void){
    const tile=initial.tile!;this.resident.set(tileKey(tile.x,tile.z),{x:tile.x,z:tile.z,worldKey:"initial",vertices:initial.meshes.reduce((n,m)=>n+m.positions.length/3,0)});
  }
  get readyKeys():ReadonlySet<string>{return new Set(this.resident.keys());}
  get failedKeys():ReadonlySet<string>{return new Set(this.failed.keys());}
  get loadingKeys():ReadonlySet<string>{return new Set(this.loading?[this.loading]:[]);}
  get stats(){return {residentBlocks:this.resident.size,failedBlocks:this.failed.size,cacheHits:this.cacheHits,builtBlocks:this.builtBlocks};}
  setQuality(quality:"low"|"balanced"):void{this.quality=quality;}
  update(x:number,z:number,velocity={x:0,z:0}):void{
    this.position={x,z};this.velocity=velocity;if(!this.pending&&!this.timer&&!this.controller.signal.aborted)this.timer=setTimeout(()=>{this.timer=undefined;void this.loadNext();},300);
  }
  isReady(x:number,z:number):boolean{return canEnterTiles(x,z,this.readyKeys);}
  canEnter(x:number,z:number):boolean{
    const ready=canEnterTiles(x,z,this.readyKeys);this.blocked=!ready;
    if(!ready){
      const tile=areaTileAt(x,z),code=this.failed.get(tileKey(tile.x,tile.z));
      this.notify(Math.abs(x)>498||Math.abs(z)>498?"選択した1kmエリアの端です。":code==="SOURCE_TOO_LARGE"?"この先は元データが大きく、取得できません。地図で別の場所を選べます。":code?"この先の街区を取得できませんでした。周辺を再試行するか、別の方向へ進んでください。":"この先の街区を準備しています。青い範囲を歩けます。");
    }return ready;
  }
  retry():void{this.failed.clear();this.attempts.clear();this.notify("周辺の街区をもう一度確認します。");this.update(this.position.x,this.position.z);}
  private async api<T>(path:string,method="GET",data?:unknown):Promise<T>{
    const response=await fetch(`/api/city/${path}`,{method,credentials:"same-origin",redirect:"error",cache:"no-store",
      signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(100_000)]),headers:{"Content-Type":"application/json","X-City-Client":"1"},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const result=await response.json() as T&{code?:string};if(!response.ok)throw new Error(result.code??"SOURCE_UNAVAILABLE");return result;
  }
  private async loadNext():Promise<void>{
    if(this.pending||this.controller.signal.aborted)return;
    const wanted=wantedTiles(this.position.x,this.position.z,this.velocity);
    const next=wanted.find(t=>!this.resident.has(tileKey(t.x,t.z))&&!this.failed.has(tileKey(t.x,t.z))&&(this.attempts.get(tileKey(t.x,t.z))?.after??0)<=Date.now());
    if(!next){if(!this.blocked)this.notify(`周辺 ${this.resident.size}街区を読み込み済み${this.failed.size?` · ${this.failed.size}街区は未取得`:""}`);return;}
    this.pending=true;const key=tileKey(next.x,next.z);this.loading=key;
    try{
      this.notify("歩きながら、近くの街区を読み込んでいます…");
      const tile:AreaTile={...this.initial.tile!,x:next.x,z:next.z};const coordinates=tileCoordinates(tile);
      const cached=await this.api<{ready:{stageId:string}|null}>("ready","POST",{latitude:tile.latitude,longitude:tile.longitude,quality:this.quality,tile});
      let stageId=cached.ready?.stageId;
      if(stageId)this.cacheHits++;
      else{
        const catalog=await this.api<{id:string}>("catalog","POST",coordinates);
        let job=await this.api<Job>("jobs","POST",{catalogId:catalog.id,quality:this.quality,tile});this.jobId=job.id;
        const started=Date.now();
        while(job.state==="running"){
          if(Date.now()-started>245_000)throw new Error("BUILD_TIMEOUT");
          await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timeout);reject(new Error("CANCELLED"));};
            const timeout=setTimeout(()=>{this.controller.signal.removeEventListener("abort",abort);resolve();},1200);this.controller.signal.addEventListener("abort",abort,{once:true});});
          job=await this.api<Job>(`jobs/${job.id}`);
        }
        if(job.state!=="ready"||!job.stageId)throw new Error(job.code??"BUILD_FAILED");
        stageId=job.stageId;this.builtBlocks++;
      }
      this.jobId="";
      if(!wantedTiles(this.position.x,this.position.z,this.velocity).some(t=>tileKey(t.x,t.z)===key))return;
      const data=await fetch(`/api/city/stages/${stageId}`,{credentials:"same-origin",redirect:"error",signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(45_000)])});
      if(!data.ok||!data.body)throw new Error("SOURCE_UNAVAILABLE");
      const reader=data.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.length;if(bytes>4*1024*1024){await reader.cancel();throw new Error("GEOMETRY_BUDGET");}chunks.push(result.value);}
      const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
      const manifest=CityManifestSchema.parse(JSON.parse(new TextDecoder().decode(buffer)) as unknown);
      if(manifest.mode!=="survey"||JSON.stringify(manifest.tile)!==JSON.stringify(tile))throw new Error("TILE_OUTPUT_MISMATCH");
      this.controller.signal.throwIfAborted();
      const vertices=manifest.meshes.reduce((n,m)=>n+m.positions.length/3,0),budget=this.quality==="low"?100_000:180_000;
      // Never remove the player's block or any surface underneath their collision radius.
      const protectedKeys=new Set(wantedTiles(this.position.x,this.position.z).filter(t=>t.distance<3).map(t=>tileKey(t.x,t.z)));
      const removable=[...this.resident.entries()].filter(([k])=>!protectedKeys.has(k)).sort(([,a],[,b])=>Math.hypot(b.x*250-this.position.x,b.z*250-this.position.z)-Math.hypot(a.x*250-this.position.x,a.z*250-this.position.z));
      const total=()=>[...this.resident.values()].reduce((n,r)=>n+r.vertices,0);
      while((this.resident.size>=5||total()+vertices>budget)&&removable.length){const [removeKey,resident]=removable.shift()!;this.world.removeBlock(resident.worldKey);this.resident.delete(removeKey);}
      if(this.resident.size>=5||total()+vertices>budget)throw new Error("GEOMETRY_BUDGET");
      await this.world.addBlock(key,manifest);this.controller.signal.throwIfAborted();
      this.resident.set(key,{x:tile.x,z:tile.z,worldKey:key,vertices});this.changed(manifest);
      this.attempts.delete(key);this.notify(`周辺 ${this.resident.size}街区を読み込み済み`);
    }catch(error){
      if(!this.controller.signal.aborted){
        const code=error instanceof Error?error.message:"BUILD_FAILED",count=(this.attempts.get(key)?.count??0)+1;
        if(code==="BUSY"){
          // Other walkers share the single conversion worker. Waiting is not a failed tile.
          this.attempts.set(key,{count:count-1,after:Date.now()+3000});this.notify("別の街区を準備中です。順番に読み込みます。");
        }else if(["SOURCE_TIMEOUT","SOURCE_UNAVAILABLE","BUILD_TIMEOUT"].includes(code)&&count<=3){
          this.attempts.set(key,{count,after:Date.now()+1000*2**count});this.notify("通信を待っています。周辺の読み込みを自動で再試行します。");
        }else{
          this.failed.set(key,code);
          this.notify(code==="GEOMETRY_BUDGET"?"描画容量が上限に達しました。軽量モードで再試行できます。":code==="SOURCE_TOO_LARGE"?"この先は元データが大きく、今の構築方式では取得できません。地図で別の場所を選べます。":"一部の街区を取得できませんでした。読み込んだ範囲を歩くか、再試行してください。");
        }
      }
    }finally{
      const unfinished=this.jobId;this.pending=false;this.loading="";this.jobId="";
      if(unfinished)void fetch(`/api/city/jobs/${unfinished}`,{method:"DELETE",credentials:"same-origin",keepalive:true,headers:{"X-City-Client":"1"}}).catch(()=>{});
    }
  }

  dispose():void{
    clearTimeout(this.timer);const id=this.jobId;this.controller.abort();
    if(id)void fetch(`/api/city/jobs/${id}`,{method:"DELETE",credentials:"same-origin",keepalive:true,headers:{"X-City-Client":"1"}}).catch(()=>{});
  }
}
