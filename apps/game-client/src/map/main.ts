import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import type { Job } from "../../../city-builder/src/service.js";

function element<T extends HTMLElement=HTMLElement>(id:string):T {const node=document.getElementById(id);if(!node)throw new Error(id);return node as T;}
const map=L.map("map",{zoomControl:false,minZoom:4,maxZoom:18}).setView([34.705,135.4967],16);
L.control.zoom({position:"topleft"}).addTo(map);
L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",{
  attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',maxZoom:18,
}).on("tileerror",()=>{element("tile-error").hidden=false;}).addTo(map);
const area=L.rectangle([[0,0],[0,0]],{color:"#183552",weight:3,fillOpacity:.06,dashArray:"8 6",interactive:false}).addTo(map);
const block=L.rectangle([[0,0],[0,0]],{color:"#097e91",weight:4,fillOpacity:.25,interactive:false}).addTo(map);
const marker=L.circleMarker([34.705,135.4967],{radius:5,color:"#fff",fillColor:"#b87338",fillOpacity:1,interactive:false}).addTo(map);
const latitude=element<HTMLInputElement>("latitude"),longitude=element<HTMLInputElement>("longitude"),quality=element<HTMLSelectElement>("quality");
const check=element<HTMLButtonElement>("check"),build=element<HTMLButtonElement>("build"),cancel=element<HTMLButtonElement>("cancel"),play=element<HTMLAnchorElement>("play");
const errors:Record<string,string>={
  ELEVATION_MISSING:"地形データに欠けた部分があります。別の街区を選んでください。",
  ELEVATION_INVALID:"地形データを読み取れませんでした。再試行するか、別の街区を選んでください。",
  ELEVATION_BUDGET:"地形の取得容量が上限を超えました。別の街区を選んでください。",
  NO_DATA:"この範囲の都市モデルは見つかりませんでした。別の場所を選んでください。",
  MISSING_ROADS_OR_BUILDINGS:"道路または建物のデータが不足しています。別の場所を選んでください。",
  MULTI_CITY_LIMIT:"この範囲は対応できる自治体数を超えます。中心を少し移動してください。",
  SOURCE_METADATA_AMBIGUOUS:"重複データの出典を確定できません。中心を少し移動してください。",
  MULTI_CITY_UNSUPPORTED:"自治体をまたぐ範囲はまだ対応していません。中心を少し移動してください。",
  SOURCE_TOO_LARGE:"この範囲は取得容量の上限を超えます。中心を移動するか、別の街区を選んでください。",
  LICENSE_REVIEW_REQUIRED:"利用条件の自動確認に対応していないデータです。出典の確認が必要です。",
  SOURCE_SIZE_UNKNOWN:"配布元でデータ容量を確認できませんでした。時間をおいて再試行してください。",
  SOURCE_UNAVAILABLE:"配布元に接続できませんでした。時間をおいて再度お試しください。",
  SOURCE_OR_GEOMETRY_UNSUPPORTED:"このデータの形状・形式には対応していません。別の街区を選んでください。",
  GEOMETRY_BUDGET:"形状が描画容量の上限を超えます。軽量モードか別の街区をお試しください。",
  NO_SAFE_SPAWN:"安全に歩き始められる道路面を見つけられませんでした。中心を移動してください。",
  BUSY:"別の確認または構築を実行中です。完了後に再度お試しください。",
  DEPENDENCIES_MISSING:"構築環境が未準備です。Node.jsのバージョンとnpm ciの実行を確認してください。",
  CATALOG_EXPIRED:"データ確認の有効時間が切れました。もう一度データを確認してください。",
  BUILD_TIMEOUT:"構築が制限時間を超えました。再試行するか別の街区を選んでください。",
};
const errorText=(error:unknown)=>errors[error instanceof Error?error.message:""]??"処理を完了できませんでした。接続と構築環境を確認し、もう一度お試しください。";
let selected={latitude:34.705,longitude:135.4967},catalogId="",version=0,jobId="",starting=false,timer:ReturnType<typeof setTimeout>|undefined;
let checking:AbortController|undefined,cancelRequested=false;
const checkData=element<HTMLButtonElement>("check-data");
let webglAvailable=true;
try{const probe=document.createElement("canvas"),gl=probe.getContext("webgl2")??probe.getContext("webgl");webglAvailable=Boolean(gl);gl?.getExtension("WEBGL_lose_context")?.loseContext();}catch{webglAvailable=false;}
element("webgl-error").hidden=webglAvailable;
const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(2)} MiB`;

async function api<T>(path:string,method="GET",data?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/city/${path}`,{method,headers:{"Content-Type":"application/json","X-City-Client":"1"},
    credentials:"same-origin",cache:"no-store",redirect:"error",...(data===undefined?{}:{body:JSON.stringify(data)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(100_000)]):AbortSignal.timeout(100_000)});
  const result=await response.json() as T & {code?:string};if(!response.ok)throw new Error(result.code??"REQUEST_FAILED");return result;
}

function select(lat:number,lng:number,move=false):void {
  if(jobId||starting||checking)return;
  version++;clearTimeout(timer);catalogId="";
  selected={latitude:Number(lat.toFixed(6)),longitude:Number(lng.toFixed(6))};
  latitude.value=String(selected.latitude);longitude.value=String(selected.longitude);
  const bounds=(half:number):L.LatLngBoundsExpression=>{const dy=half/110574,dx=half/(111320*Math.cos(lat*Math.PI/180));return [[lat-dy,lng-dx],[lat+dy,lng+dx]];};
  area.setBounds(bounds(500));block.setBounds(bounds(125));marker.setLatLng([lat,lng]);if(move)map.setView([lat,lng],16);
  play.hidden=build.hidden=true;element("job").hidden=true;check.disabled=!webglAvailable;check.textContent="この場所で歩く";
  element("area-name").textContent="選択したエリア";element("availability").textContent="中央の街区ができたら入場します。周辺は歩きながら読み込みます。地域により構築できない場合があります。";
  element("nearby").hidden=true;
  element("source-summary").textContent="";element("planner-status").textContent="";
}
select(selected.latitude,selected.longitude);
for(const nav of document.querySelectorAll<HTMLElement>(".places"))L.DomEvent.disableClickPropagation(nav);
map.on("click",(event:L.LeafletMouseEvent)=>{if(event.latlng.lat>=20&&event.latlng.lat<=46&&event.latlng.lng>=122&&event.latlng.lng<=154)select(event.latlng.lat,event.latlng.lng);});
for(const button of document.querySelectorAll<HTMLButtonElement>("[data-place]"))button.addEventListener("click",()=>{const [lat,lng]=button.dataset.place!.split(",").map(Number);select(lat!,lng!,true);});
element("japan").addEventListener("click",()=>map.setView([36,138],5));
element<HTMLFormElement>("coordinates").addEventListener("submit",event=>{event.preventDefault();select(Number(latitude.value),Number(longitude.value),true);});
quality.addEventListener("change",()=>{if(!jobId){play.hidden=true;build.hidden=!catalogId;}});

async function nearby(current:number):Promise<void>{
  try{
    const result=await api<{places:{latitude:number;longitude:number;distanceMeters:number}[]}>("nearby","POST",{...selected,quality:quality.value});
    if(current!==version)return;const list=element("nearby-places");list.replaceChildren();
    for(const place of result.places){const button=document.createElement("button");button.textContent=`約${place.distanceMeters}m先の準備済みエリア`;button.addEventListener("click",()=>select(place.latitude,place.longitude,true));list.append(button);}
    element("nearby").hidden=result.places.length===0;
  }catch{/* Nearby suggestions are optional; the original failure remains visible. */}
}
async function prepare(enter:boolean):Promise<void>{
  if(enter&&!webglAvailable)return;
  const current=++version;checking?.abort();checking=new AbortController();lock(true);build.hidden=play.hidden=true;cancel.hidden=false;
  element("job").hidden=false;element("job-title").textContent="街の準備を確認中";element<HTMLProgressElement>("progress").removeAttribute("value");element("job-detail").textContent="完成済みの街があれば、そのまま入場します。";element("elapsed").textContent="";
  const began=performance.now();const clock=setInterval(()=>{if(current===version)element("elapsed").textContent=`確認開始から ${Math.floor((performance.now()-began)/1000)}秒`;},1000);
  catalogId="";
  element("availability").textContent="建物・道路の収録範囲と利用条件を確認中…";
  try{
    const cached=await api<{ready:{stageId:string}|null}>("ready","POST",{...selected,quality:quality.value},checking.signal);
    if(current!==version)return;
    if(cached.ready){
      play.href=`/walk.html?stage=${encodeURIComponent(cached.ready.stageId)}&quality=${quality.value}&autostart=1`;
      element("availability").textContent="準備済みの街があります。すぐに入場できます。";element("job").hidden=true;
      if(enter)location.assign(play.href);else play.hidden=!webglAvailable;return;
    }
    const result=await api<{id:string;city:string;year:number;license:string;sourceBytes:number;files:number;datasets:{city:string;year:number}[];planner:string}>("catalog","POST",selected,checking.signal);
    if(current!==version)return;catalogId=result.id;element("area-name").textContent=result.city;
    element("availability").textContent="建物・道路のデータがあります。形状と地形は構築時に確認します。";
    element("source-summary").textContent=`${result.datasets.map(d=>`${d.city} ${d.year}年度`).join(" / ")} · ${result.license} · 元データ ${size(result.sourceBytes)} / ${result.files}ファイル。端末には変換した街区だけを送ります。`;
    element("planner-status").textContent=result.planner==="gemini-adk"?"AIが描画予算内の構築プランを選びます。":"自動構築が利用できます。AIプランナーは未接続です。";checking=undefined;clearInterval(clock);if(enter)await construct();else{element("job").hidden=true;build.hidden=!webglAvailable;build.textContent="このデータで街を構築する";}
  }catch(error){if(current===version){element("availability").textContent=errorText(error);element("job-title").textContent="街を準備できませんでした";element("job-detail").textContent=errorText(error);void nearby(current);}}
  finally{clearInterval(clock);if(current===version){checking=undefined;lock(Boolean(jobId)||starting);if(!jobId)cancel.hidden=true;}}
}
check.addEventListener("click",()=>{void prepare(true);});
checkData.addEventListener("click",()=>{void prepare(false);});

function lock(value:boolean):void {
  checkData.disabled=value;check.disabled=value||!webglAvailable;quality.disabled=latitude.disabled=longitude.disabled=value;
  for(const button of document.querySelectorAll<HTMLButtonElement>("[data-place], #coordinates button"))button.disabled=value;
}

function showJob(job:Job):void {
  element("job").hidden=false;const progress=element<HTMLProgressElement>("progress");
  const labels:Record<string,string>={plan:"構築プランを準備中",download:"必要なデータを取得中",convert:"街区の形状を変換中",terrain:"地形の高さを読み込み中",validate:"開始地点と容量を検証中",ready:"街の準備ができました"};
  element("job-title").textContent=labels[job.phase]??"街を構築中";
  if(job.state==="ready")progress.value=100;else progress.removeAttribute("value");
  const p=job.progress;
  element("job-detail").textContent=p.phase==="download"?`${p.completed??0} / ${p.total??0} ファイル取得済み · ${size(p.bytes??0)}`:"地図はそのまま操作できます。構築中はエリアの変更を止めています。";
  element("elapsed").textContent=`経過 ${Math.round((Date.now()-job.createdAt)/1000)}秒`;
  if(job.state==="running")return;
  jobId="";lock(false);cancel.hidden=true;
  if(job.state==="ready" && job.stageId){
    play.href=`/walk.html?stage=${encodeURIComponent(job.stageId)}&quality=${quality.value}&autostart=1`;play.hidden=false;build.hidden=true;
    element("job-detail").textContent=`街区 ${size(job.stats?.gzipBytes??0)}（圧縮転送） · ${(job.stats?.vertices??0).toLocaleString()}頂点 · ${job.provider==="gemini-adk"?"AIプラン":"自動プラン / AI未接続"}`;
    element("elapsed").textContent=`構築 ${(job.stats?.totalSeconds??0).toFixed(1)}秒。完成済みの街区は再利用します。`;
    location.assign(play.href);
  }else{
    element("job-title").textContent=job.state==="cancelled"?"構築を中止しました":"構築できませんでした";
    element("job-detail").textContent=job.state==="cancelled"?"別の街区を選ぶか、再度構築できます。":errorText(new Error(job.code));void nearby(version);build.hidden=false;build.disabled=false;
  }
}
async function poll(id:string):Promise<void>{
  try{const job=await api<Job>(`jobs/${id}`);if(id!==jobId)return;showJob(job);if(job.state==="running")timer=setTimeout(()=>{void poll(id);},1500);}
  catch(error){if(id!==jobId)return;element("job-detail").textContent=errorText(error);timer=setTimeout(()=>{void poll(id);},4000);}
}
async function construct():Promise<void>{
  starting=true;cancelRequested=false;build.disabled=true;lock(true);cancel.hidden=false;play.hidden=true;
  try{const job=await api<Job>("jobs","POST",{catalogId,quality:quality.value,tile:{...selected,x:0,z:0}});jobId=job.id;if(cancelRequested){const stopped=await api<Job>(`jobs/${job.id}`,"DELETE");showJob(stopped);}else{showJob(job);if(job.state==="running")void poll(job.id);}}
  catch(error){lock(false);element("availability").textContent=errorText(error);cancel.hidden=true;void nearby(version);}
  finally{starting=false;lock(Boolean(jobId));build.disabled=false;build.hidden=Boolean(jobId);}
}
build.addEventListener("click",()=>{void construct();});
cancel.addEventListener("click",()=>{void (async()=>{
  if(checking){version++;checking.abort();checking=undefined;cancel.hidden=true;lock(false);element("job").hidden=true;element("availability").textContent="確認を中止しました。別の場所を選べます。";return;}
  if(starting&&!jobId){cancelRequested=true;element("job-detail").textContent="構築の開始を取り消しています…";return;}
  if(!jobId)return;cancel.disabled=true;
  try{const job=await api<Job>(`jobs/${jobId}`,"DELETE");clearTimeout(timer);showJob(job);}
  catch(error){element("job-detail").textContent=errorText(error);}finally{cancel.disabled=false;}
})();});
window.addEventListener("pagehide",()=>{checking?.abort();clearTimeout(timer);if(jobId)void fetch(`/api/city/jobs/${jobId}`,{method:"DELETE",credentials:"same-origin",keepalive:true,headers:{"X-City-Client":"1"}}).catch(()=>{});});
