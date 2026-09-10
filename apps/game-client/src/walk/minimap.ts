import { tileBounds, tileKey } from "../../../../packages/contracts/src/area.js";
export function drawMinimap(canvas:HTMLCanvasElement,x:number,z:number,ready:ReadonlySet<string>,failed:ReadonlySet<string>,loading:ReadonlySet<string>=new Set()):void{
  const ctx=canvas.getContext("2d");if(!ctx)return;
  const size=canvas.width,scale=size/1000;ctx.clearRect(0,0,size,size);
  for(let tx=-2;tx<=2;tx++)for(let tz=-2;tz<=2;tz++){
    const bounds=tileBounds({x:tx,z:tz}),key=tileKey(tx,tz);ctx.fillStyle=ready.has(key)?"#416977":loading.has(key)?"#b88432":failed.has(key)?"#684139":"#202c3c";
    ctx.fillRect((bounds.minX+500)*scale,(bounds.minZ+500)*scale,(bounds.maxX-bounds.minX)*scale-1,(bounds.maxZ-bounds.minZ)*scale-1);
  }
  ctx.fillStyle="#ffdc99";ctx.beginPath();ctx.arc((x+500)*scale,(z+500)*scale,4,0,Math.PI*2);ctx.fill();
}
