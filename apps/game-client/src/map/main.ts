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
  NO_DATA:"この範囲の都市モデルは見つかりませんでした。別の場所を選んでください。",
  MISSING_ROADS_OR_BUILDINGS:"道路または建物のデータが不足しています。別の場所を選んでください。",
  MULTI_CITY_UNSUPPORTED:"自治体をまたぐ範囲はまだ対応していません。中心を少し移動してください。",
  SOURCE_TOO_LARGE:"この範囲は取得容量の上限を超えます。中心を移動するか、別の街区を選んでください。",
  LICENSE_REVIEW_REQUIRED:"利用条件の自動確認に対応していないデータです。出典の確認が必要です。",
  SOURCE_UNAVAILABLE:"配布元に接続できませんでした。時間をおいて再度お試しください。",
  SOURCE_OR_GEOMETRY_UNSUPPORTED:"このデータの形状・形式には対応していません。別の街区を選んでください。",
  GEOMETRY_BUDGET:"形状が描画容量の上限を超えます。軽量モードか別の街区をお試しください。",
  NO_SAFE_SPAWN:"安全に歩き始められる道路面を見つけられませんでした。中心を移動してください。",
  BUSY:"別の確認または構築を実行中です。完了後に再度お試しください。",
  DEPENDENCIES_MISSING:"構築環境が未準備です。起動手順のPython依存関係を確認してください。",
  CATALOG_EXPIRED:"データ確認の有効時間が切れました。もう一度データを確認してください。",
  BUILD_TIMEOUT:"構築が制限時間を超えました。再試行するか別の街区を選んでください。",
};
const errorText=(error:unknown)=>errors[error instanceof Error?error.message:""]??"処理を完了できませんでした。接続と構築環境を確認し、もう一度お試しください。";
let selected={latitude:34.705,longitude:135.4967},catalogId="",version=0,jobId="",starting=false,timer:ReturnType<typeof setTimeout>|undefined;
let checking:AbortController|undefined;
const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(2)} MiB`;

async function api<T>(path:string,method="GET",data?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/city/${path}`,{method,headers:{"Content-Type":"application/json","X-City-Client":"1"},
    credentials:"same-origin",cache:"no-store",redirect:"error",...(data===undefined?{}:{body:JSON.stringify(data)}),signal:signal??AbortSignal.timeout(100_000)});
  const result=await response.json() as T & {code?:string};if(!response.ok)throw new Error(result.code??"REQUEST_FAILED");return result;
}

function select(lat:number,lng:number,move=false):void {
  if(jobId||starting)return;
  version++;checking?.abort();clearTimeout(timer);catalogId="";
  selected={latitude:Number(lat.toFixed(6)),longitude:Number(lng.toFixed(6))};
  latitude.value=String(selected.latitude);longitude.value=String(selected.longitude);
  const bounds=(half:number):L.LatLngBoundsExpression=>{const dy=half/110574,dx=half/(111320*Math.cos(lat*Math.PI/180));return [[lat-dy,lng-dx],[lat+dy,lng+dx]];};
  area.setBounds(bounds(500));block.setBounds(bounds(125));marker.setLatLng([lat,lng]);if(move)map.setView([lat,lng],16);
  play.hidden=build.hidden=true;element("job").hidden=true;check.disabled=false;check.textContent="この範囲のデータを確認";
  element("area-name").textContent="選択したエリア";element("availability").textContent="中央250m街区のデータを確認します。外枠1km全体の構築は今後対応します。";
  element("source-summary").textContent="";element("planner-status").textContent="";
}
select(selected.latitude,selected.longitude);
map.on("click",(event:L.LeafletMouseEvent)=>{if(event.latlng.lat>=20&&event.latlng.lat<=46&&event.latlng.lng>=122&&event.latlng.lng<=154)select(event.latlng.lat,event.latlng.lng);});
for(const button of document.querySelectorAll<HTMLButtonElement>("[data-place]"))button.addEventListener("click",()=>{const [lat,lng]=button.dataset.place!.split(",").map(Number);select(lat!,lng!,true);});
element("japan").addEventListener("click",()=>map.setView([36,138],5));
element<HTMLFormElement>("coordinates").addEventListener("submit",event=>{event.preventDefault();select(Number(latitude.value),Number(longitude.value),true);});
quality.addEventListener("change",()=>{if(!jobId){play.hidden=true;build.hidden=!catalogId;}});

check.addEventListener("click",()=>{void (async()=>{
  const current=++version;checking?.abort();checking=new AbortController();check.disabled=true;build.hidden=play.hidden=true;
  catalogId="";
  element("availability").textContent="建物・道路の収録範囲と利用条件を確認中…";
  try{
    const result=await api<{id:string;city:string;year:number;license:string;sourceBytes:number;files:number;planner:string}>("catalog","POST",selected,checking.signal);
    if(current!==version)return;catalogId=result.id;element("area-name").textContent=result.city;
    element("availability").textContent="構築できるデータが見つかりました。";
    element("source-summary").textContent=`${result.year}年度 · ${result.license} · 元データ ${size(result.sourceBytes)} / ${result.files}ファイル。端末には変換した街区だけを送ります。`;
    element("planner-status").textContent=result.planner==="gemini-adk"?"AIが描画予算内の構築プランを選びます。":"自動構築が利用できます。AIプランナーは未接続です。";build.hidden=false;
  }catch(error){if(current===version)element("availability").textContent=errorText(error);}
  finally{if(current===version)check.disabled=false;}
})();});

function lock(value:boolean):void {
  check.disabled=quality.disabled=latitude.disabled=longitude.disabled=value;
  for(const button of document.querySelectorAll<HTMLButtonElement>("[data-place], #coordinates button"))button.disabled=value;
}

function showJob(job:Job):void {
  element("job").hidden=false;const progress=element<HTMLProgressElement>("progress");
  const labels:Record<string,string>={plan:"構築プランを準備中",download:"必要なデータを取得中",convert:"街区の形状を変換中",validate:"開始地点と容量を検証中",ready:"街の準備ができました"};
  element("job-title").textContent=labels[job.phase]??"街を構築中";
  if(job.state==="ready")progress.value=100;else progress.removeAttribute("value");
  const p=job.progress;
  element("job-detail").textContent=p.phase==="download"?`${p.completed??0} / ${p.total??0} ファイル取得済み · ${size(p.bytes??0)}`:"地図はそのまま操作できます。構築中はエリアの変更を止めています。";
  element("elapsed").textContent=`経過 ${Math.round((Date.now()-job.createdAt)/1000)}秒`;
  if(job.state==="running")return;
  jobId="";lock(false);cancel.hidden=true;
  if(job.state==="ready" && job.stageId){
    play.href=`/walk.html?stage=${encodeURIComponent(job.stageId)}&quality=${quality.value}`;play.hidden=false;build.hidden=true;
    element("job-detail").textContent=`街区 ${size(job.stats?.gzipBytes??0)}（圧縮転送） · ${(job.stats?.vertices??0).toLocaleString()}頂点 · ${job.provider==="gemini-adk"?"AIプラン":"自動プラン / AI未接続"}`;
    element("elapsed").textContent=`構築 ${(job.stats?.totalSeconds??0).toFixed(1)}秒。完成済みの街区は再利用します。`;
  }else{
    element("job-title").textContent=job.state==="cancelled"?"構築を中止しました":"構築できませんでした";
    element("job-detail").textContent=job.state==="cancelled"?"別の街区を選ぶか、再度構築できます。":errorText(new Error(job.code));build.hidden=false;build.disabled=false;
  }
}
async function poll(id:string):Promise<void>{
  try{const job=await api<Job>(`jobs/${id}`);if(id!==jobId)return;showJob(job);if(job.state==="running")timer=setTimeout(()=>{void poll(id);},1500);}
  catch(error){if(id!==jobId)return;element("job-detail").textContent=errorText(error);timer=setTimeout(()=>{void poll(id);},4000);}
}
build.addEventListener("click",()=>{void (async()=>{
  starting=true;build.disabled=true;lock(true);cancel.hidden=false;play.hidden=true;
  try{const job=await api<Job>("jobs","POST",{catalogId,quality:quality.value});jobId=job.id;showJob(job);if(job.state==="running")void poll(job.id);}
  catch(error){lock(false);element("availability").textContent=errorText(error);}
  finally{starting=false;build.disabled=false;build.hidden=Boolean(jobId);}
})();});
cancel.addEventListener("click",()=>{void (async()=>{
  if(!jobId)return;cancel.disabled=true;
  try{const job=await api<Job>(`jobs/${jobId}`,"DELETE");clearTimeout(timer);showJob(job);}
  catch(error){element("job-detail").textContent=errorText(error);}finally{cancel.disabled=false;}
})();});
window.addEventListener("pagehide",()=>{checking?.abort();clearTimeout(timer);});
