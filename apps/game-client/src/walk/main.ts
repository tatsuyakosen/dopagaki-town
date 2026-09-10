import { WalkPerformance } from "./performance.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { CityManifestSchema, type CityManifest } from "@dopagaki/contracts";
import "@babylonjs/core/Collisions/collisionCoordinator.js";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder.js";
import "@babylonjs/core/Culling/ray.js";
import { createFixture } from "./fixture.js";
import { movementVector, frameSeconds, movementSteps } from "./movement.js";
import { createWalkWorld, type WalkWorld } from "./world.js";
import { CollisionGrid } from "./spatial.js";
import { AreaStreamer } from "./streaming.js";
import { drawMinimap } from "./minimap.js";
import "./style.css";

function element<T extends HTMLElement>(id:string):T {
  const value=document.getElementById(id);if(!value)throw new Error(`Missing UI: ${id}`);return value as T;
}
const canvas=element<HTMLCanvasElement>("walk-canvas");
const notice=element("notice");const message=element("load-message");
const start=element<HTMLButtonElement>("start");const pause=element<HTMLButtonElement>("pause");
const hud=element("walk-hud");const keys=new Set<string>();

async function readManifest():Promise<CityManifest> {
  if(new URLSearchParams(location.search).get("fixture")==="1")return CityManifestSchema.parse(createFixture());
  const stage=new URLSearchParams(location.search).get("stage");
  if(stage!==null && !/^[a-f0-9]{24}$/.test(stage))throw new Error("INVALID_STAGE");
  const response=await fetch(stage?`/api/city/stages/${stage}`:"/city-data/umeda-block.json",{credentials:"same-origin",cache:stage?"default":"no-store",redirect:"error",signal:AbortSignal.timeout(20_000)});
  if(!response.ok || !response.body)throw new Error("DATA_UNAVAILABLE");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>20*1024*1024){await reader.cancel();throw new Error("DATA_TOO_LARGE");}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const manifest=CityManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  if(manifest.mode!=="survey")throw new Error("SURVEY_REQUIRED");return manifest;
}

function credits(manifest:CityManifest):void {
  element("place-name").textContent=manifest.title;
  element("dataset-kind").textContent=manifest.mode==="survey"?"実データの形状 / 外装・夕景は演出":"架空の操作検証 / 実際の大阪ではありません";
  element("scope").textContent=manifest.tile?"1km × 1km / 周辺の街区を順に読み込み":`歩行範囲 ${manifest.playableHalfSize*2}m × ${manifest.playableHalfSize*2}m`;
  const parent=element("provenance");
  parent.replaceChildren();
  for(const source of manifest.sources){const p=document.createElement("p");p.textContent=`${source.attribution} / データ年度 ${source.datasetYear??"不明"} / 測量年度 ${source.surveyYear??"未確認"} / 取得 ${source.retrievedAt}`;
    const a=document.createElement("a");a.href=source.url;a.textContent="データ配布元";a.target="_blank";a.rel="noopener noreferrer";
    const license=document.createElement("a");license.href=source.licenseUrl;license.textContent=source.license;license.target="_blank";license.rel="noopener noreferrer";p.append(" · ",a," · ",license);parent.append(p);}
  for(const text of manifest.limitations){const p=document.createElement("p");p.textContent=text;parent.append(p);}
  const p=document.createElement("p");p.textContent="窓・外壁材・夕景は視認性のための演出であり、実写再現ではありません。現況・私有地への立入り可否を示すものではありません。";parent.append(p);
}

async function boot():Promise<void> {
  const loadedAt=performance.now();
  let phase="data";
  let engine:Engine|null=null;let world:WalkWorld|null=null;let streamer:AreaStreamer|undefined;
  try{
    const manifest=await readManifest();
    phase="engine";
    const initialLow=new URLSearchParams(location.search).get("quality")==="low";
    element<HTMLSelectElement>("quality").value=initialLow?"low":"balanced";
    engine=new Engine(canvas,true,{preserveDrawingBuffer:false,stencil:true});engine.setHardwareScalingLevel(initialLow?2.25:1.5);
    const scene=new Scene(engine);scene.collisionsEnabled=true;scene.shadowsEnabled=!initialLow;scene.skipPointerMovePicking=true;
    scene.clearColor=new Color4(.42,.35,.39,1);scene.fogMode=Scene.FOGMODE_EXP2;scene.fogDensity=.002;
    scene.fogColor=new Color3(.42,.35,.39);scene.imageProcessingConfiguration.exposure=1.15;
    scene.imageProcessingConfiguration.contrast=1.15;scene.imageProcessingConfiguration.toneMappingEnabled=true;
    const sun=new DirectionalLight("sunset",new Vector3(-.65,-.42,.58),scene);
    sun.position=new Vector3(100,120,-100);sun.diffuse=new Color3(1,.71,.43);sun.intensity=2;
    const sky=new HemisphericLight("sky",Vector3.Up(),scene);sky.diffuse=new Color3(.56,.67,1);sky.groundColor=new Color3(.13,.12,.16);sky.intensity=.7;
    const shadows=new ShadowGenerator(1024,sun);shadows.usePercentageCloserFiltering=true;shadows.bias=.001;shadows.normalBias=.025;
    phase="geometry";
    world=await createWalkWorld(scene,manifest,shadows,(done,total)=>{message.textContent=`街区を配置中 ${done} / ${total}。操作画面を準備しています。`;});const activeWorld=world;
    let grid=new CollisionGrid(world.colliders),gridRevision=world.revision;let nearby=world.colliders,lastCell="";
    const camera=new FreeCamera("walk-camera",new Vector3(0,3,10),scene);camera.inputs.clear();camera.minZ=.15;camera.maxZ=1500;camera.fov=.85;
    scene.activeCamera=camera;
    const player=MeshBuilder.CreateCapsule("walker",{height:1.8,radius:.35,tessellation:12},scene);
    player.ellipsoid=new Vector3(.42,.9,.42);player.ellipsoidOffset=Vector3.Zero();player.isPickable=false;
    const coat=new StandardMaterial("walker-coat",scene);coat.diffuseColor=Color3.FromHexString("#264959");coat.specularColor.set(.15,.15,.15);player.material=coat;shadows.addShadowCaster(player);
    const visor=MeshBuilder.CreateSphere("walker-head",{diameter:.42,segments:12},scene);visor.parent=player;visor.position.y=.64;
    const skin=new StandardMaterial("walker-head-material",scene);skin.diffuseColor=Color3.FromHexString("#c7ab83");visor.material=skin;visor.isPickable=false;
    let yaw=Math.PI, pitch=.32, verticalSpeed=0, paused=true, drag=false, gateClosed=false;
    const spawn=new Vector3(manifest.spawn[0],manifest.spawn[1],manifest.spawn[2]);
    let lowestGround=Math.min(...manifest.meshes.filter(m=>m.kind!=="building").flatMap(m=>m.positions.filter((_,i)=>i%3===1)));
    const safePosition=spawn.clone();
    if(manifest.tile){
      const seenSources=new Set(manifest.sources.map(source=>source.sha256));
      streamer=new AreaStreamer(manifest,activeWorld,initialLow?"low":"balanced",text=>{element("stream-status").textContent=text;},block=>{
        lowestGround=Math.min(lowestGround,...block.meshes.filter(m=>m.kind!=="building").flatMap(m=>m.positions.filter((_,i)=>i%3===1)));
        for(const source of block.sources)if(!seenSources.has(source.sha256)){seenSources.add(source.sha256);manifest.sources.push(source);}
        credits(manifest);
      });
      element("area-map").hidden=false;element("retry-area").addEventListener("click",()=>streamer?.retry());
    }
    phase="spawn";
    // A building roof is never accepted as a street spawn; terrain/road data is required.
    const spawnRay=new Ray(new Vector3(spawn.x,2000,spawn.z),Vector3.Down(),4000);
    const hit=scene.pickWithRay(spawnRay,(mesh)=>activeWorld.colliders.has(mesh as Mesh)&&mesh.isEnabled());
    if(!hit?.hit||!hit.pickedPoint||!activeWorld.surfaces.has(hit.pickedMesh as Mesh))throw new Error("UNSAFE_SPAWN");
    spawn.y=hit.pickedPoint.y+.95;player.position.copyFrom(spawn);
    function setPaused(value:boolean):void{paused=value;keys.clear();pause.textContent=value?"再開":"一時停止";notice.hidden=!value;if(value){notice.querySelector("h1")!.textContent="街歩きを一時停止";message.textContent="再開すると同じ場所から歩けます。";}else canvas.focus();}
    function reset():void{keys.clear();verticalSpeed=0;player.position.copyFrom(safePosition);}
    pause.disabled=false;pause.addEventListener("click",()=>setPaused(!paused));
    start.addEventListener("click",()=>{setPaused(false);start.textContent="再開する";});
    element("reset").addEventListener("click",()=>{
      if(streamer&&!streamer.isReady(spawn.x,spawn.z)){location.reload();return;}
      safePosition.copyFrom(spawn);reset();
    });
    const gateButton=element<HTMLButtonElement>("gate");gateButton.hidden=manifest.mode!=="fixture";
    gateButton.addEventListener("click",()=>{
      if(!gateClosed && Math.abs(player.position.x)<17 && Math.abs(player.position.z-20)<1.5){gateButton.textContent="ゲートから少し離れてください";return;}
      gateClosed=!gateClosed;activeWorld.gate?.setEnabled(gateClosed);gateButton.textContent=`検証ゲート：${gateClosed?"閉":"開"}`;canvas.focus();
    });
    element<HTMLSelectElement>("quality").addEventListener("change",(event)=>{
      const quality=(event.target as HTMLSelectElement).value;
      streamer?.setQuality(quality==="low"?"low":"balanced");
      engine!.setHardwareScalingLevel(quality==="low"?2.25:quality==="high"?1:1.5);
      scene.shadowsEnabled=quality!=="low";engine!.resize();
    });
    const controls=new Set(["KeyW","KeyA","KeyS","KeyD","ShiftLeft","ShiftRight","ArrowLeft","ArrowRight","ArrowUp","ArrowDown"]);
    window.addEventListener("keydown",(event)=>{
      if(event.code==="Escape"){setPaused(true);return;}
      if(paused || (event.target instanceof Element && event.target.closest("button,select,a,input,summary")))return;
      if(controls.has(event.code)){event.preventDefault();keys.add(event.code);}
    });
    window.addEventListener("keyup",(event)=>keys.delete(event.code));
    window.addEventListener("blur",()=>{drag=false;setPaused(true);});
    document.addEventListener("visibilitychange",()=>{if(document.hidden)setPaused(true);});
    canvas.addEventListener("pointerdown",(event)=>{if(paused)return;drag=true;canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener("pointerup",()=>{drag=false;});canvas.addEventListener("pointercancel",()=>{drag=false;});
    canvas.addEventListener("pointermove",(event)=>{if(!drag||paused)return;yaw+=event.movementX*.005;pitch=Math.max(.05,Math.min(.95,pitch+event.movementY*.004));});
    let recorder:WalkPerformance|undefined,recordingActive=false;
    const measure=element<HTMLButtonElement>("measure"),downloadReport=element<HTMLButtonElement>("download-performance");
    measure.addEventListener("click",()=>{recorder=new WalkPerformance();recordingActive=false;measure.disabled=true;downloadReport.hidden=true;element("measurement-status").textContent="歩行中の60秒を計測します。一時停止中は計測しません。";});
    downloadReport.addEventListener("click",()=>{
      if(!recorder?.complete)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(recorder.report(),null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.href=url;link.download="city-walk-performance.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    let metricsAt=0,slowSeconds=0,autoReduced=initialLow;
    scene.onBeforeRenderObservable.add(()=>{
      const frameMs=engine!.getDeltaTime(),dt=frameSeconds(frameMs);
      if(recorder&&!recorder.complete&&!paused&&!document.hidden){
        if(recordingActive){
          const heap=(performance as Performance&{memory?:{usedJSHeapSize?:number}}).memory?.usedJSHeapSize;
          recorder.add(frameMs,element<HTMLSelectElement>("quality").value,activeWorld.vertices,streamer?.stats.residentBlocks??1,heap);
          if(recorder.complete){measure.disabled=false;downloadReport.hidden=false;const report=recorder.report();element("measurement-status").textContent=`平均 ${report.averageFps} FPS · 遅い側5%の境目 ${report.p95FrameMs}ms · 100ms超 ${report.framesOver100Ms}回`;}
        }
        recordingActive=true;
      }else recordingActive=false;
      if(gridRevision!==activeWorld.revision){grid=new CollisionGrid(activeWorld.colliders);gridRevision=activeWorld.revision;lastCell="";}
      const cell=grid.key(player.position.x,player.position.z);
      if(cell!==lastCell){lastCell=cell;nearby=grid.nearby(player.position.x,player.position.z);player.surroundingMeshes=[...nearby];}
      if(!paused){
        yaw+=(Number(keys.has("ArrowRight"))-Number(keys.has("ArrowLeft")))*dt*1.7;
        pitch=Math.max(.05,Math.min(.95,pitch+(Number(keys.has("ArrowDown"))-Number(keys.has("ArrowUp")))*dt));
        const movement=movementVector(keys,yaw);
        for(const step of movementSteps(dt)){
        const previousY=player.position.y;
        player.computeWorldMatrix(true);
        verticalSpeed=Math.max(-25,verticalSpeed-18*step);
        let dx=movement.x*movement.speed*step,dz=movement.z*movement.speed*step;
        if(streamer&&!streamer.canEnter(player.position.x+dx,player.position.z+dz)){dx=0;dz=0;}
        player.moveWithCollisions(new Vector3(dx,verticalSpeed*step,dz));
        if(Math.abs(player.position.y-previousY)<.002)verticalSpeed=-.5;
        }
        if(movement.x||movement.z)player.rotation.y=Math.atan2(movement.x,movement.z);
        if(player.position.y<lowestGround-10 || Math.abs(player.position.x)>manifest.playableHalfSize+2 || Math.abs(player.position.z)>manifest.playableHalfSize+2)reset();
        const ground=scene.pickWithRay(new Ray(player.position,Vector3.Down(),1.1),mesh=>activeWorld.surfaces.has(mesh as Mesh)&&nearby.has(mesh as Mesh));
        if(ground?.hit&&ground.pickedPoint&&(!streamer||streamer.isReady(player.position.x,player.position.z)))safePosition.copyFrom(player.position);
        streamer?.update(player.position.x,player.position.z,{x:movement.x*movement.speed,z:movement.z*movement.speed});
      }
      const target=player.position.add(new Vector3(0,.65,0));
      const direction=new Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
      let distance=5.5;
      for(const offset of [Vector3.Zero(),new Vector3(.25,0,0),new Vector3(-.25,0,0),new Vector3(0,.2,0),new Vector3(0,-.2,0)]){
        const pick=scene.pickWithRay(new Ray(target.add(offset),direction,5.5),mesh=>nearby.has(mesh as Mesh)&&mesh.isEnabled());
        if(pick?.hit)distance=Math.min(distance,Math.max(.25,pick.distance-.3));
      }
      camera.position.copyFrom(target.add(direction.scale(distance)));camera.setTarget(target);
      player.visibility=distance<1?.15:1;visor.visibility=player.visibility;
      if(!paused && !autoReduced){slowSeconds=engine!.getFps()<24?slowSeconds+dt:Math.max(0,slowSeconds-dt);if(slowSeconds>5){autoReduced=true;streamer?.setQuality("low");engine!.setHardwareScalingLevel(2.25);scene.shadowsEnabled=false;engine!.resize();element<HTMLSelectElement>("quality").value="low";element("performance-note").textContent="動作を軽くするため描画品質を下げました。";}}
      if(performance.now()-metricsAt>500){metricsAt=performance.now();element("metrics").textContent=`${Math.round(engine!.getFps())} FPS · E ${player.position.x.toFixed(1)}m / N ${(-player.position.z).toFixed(1)}m`;
        if(streamer)drawMinimap(element<HTMLCanvasElement>("area-canvas"),player.position.x,player.position.z,streamer.readyKeys,streamer.failedKeys,streamer.loadingKeys);
        if(recorder&&!recorder.complete)element("measurement-status").textContent=`歩行中 ${Math.floor(recorder.seconds)} / 60秒を計測済み。${paused?"再開すると計測を続けます。":"周囲を見ながら歩いてください。"}`;}
    });
    credits(manifest);hud.hidden=false;
    engine.runRenderLoop(()=>scene.render());
    message.textContent="陰影と描画の準備中…";
    phase="shaders";
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("SHADER_TIMEOUT")),30_000);
      void scene.whenReadyAsync().then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);reject(new Error("SHADER_FAILED"));});
    });
    start.hidden=false;element("performance-note").textContent=`街区の読み込み ${( (performance.now()-loadedAt)/1000).toFixed(1)}秒`;
    notice.querySelector("h1")!.textContent=manifest.mode==="fixture"?"架空の検証ステージ":"実データの街区を歩く";
    message.textContent=manifest.mode==="fixture"?"このステージは操作と夕景表現の検証用です。大阪・梅田の街並みではありません。":"建物と地面は記録された年度のデータです。外装・窓・夕景は演出で、現在の外観や通行可能性を保証しません。";
    if(new URLSearchParams(location.search).get("autostart")==="1")setPaused(false);
    window.addEventListener("resize",()=>engine!.resize());
    window.addEventListener("pagehide",(event)=>{if(event.persisted){setPaused(true);return;}streamer?.dispose();activeWorld.dispose();scene.dispose();engine!.dispose();});
  }catch(error){
    const detail=error instanceof Error?error.message:"";
    const code=/webgl/i.test(detail)?"WEBGL_UNAVAILABLE":/^[A-Z_]{3,40}$/.test(detail)?detail:"RENDER_OR_DATA_INVALID";
    console.error("CITY_WALK_FAILED "+JSON.stringify({phase,code}));
    streamer?.dispose();world?.dispose();engine?.dispose();hud.hidden=true;pause.disabled=true;start.hidden=true;
    notice.hidden=false;notice.querySelector("h1")!.textContent="実都市データを利用できません";
    message.textContent="データの有効期限切れ・形式不正・容量超過・安全な開始地点がない、または3D描画に非対応です。地図から街区を作り直すか、描画環境を確認してください。";
    if(code==="WEBGL_UNAVAILABLE")message.textContent="このブラウザではWebGLを利用できません。PCブラウザのグラフィック設定を確認して開き直してください。";
    if(code==="WEBGL_UNAVAILABLE")notice.querySelector("h1")!.textContent="3D描画を利用できません";
    element("fixture-link").hidden=false;
  }
}
void boot();
