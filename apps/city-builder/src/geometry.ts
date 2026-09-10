import earcut from "earcut";

export type Point=[number,number,number];
export const round=(value:number):number=>Math.round(value*10000)/10000 || 0;
const radians=(degrees:number)=>degrees*Math.PI/180;

function ecef([latitude,longitude,height]:Point):Point{
  const lat=radians(latitude),lon=radians(longitude),f=1/298.257222101,e2=f*(2-f);
  const n=6378137/Math.sqrt(1-e2*Math.sin(lat)**2);
  return [(n+height)*Math.cos(lat)*Math.cos(lon),(n+height)*Math.cos(lat)*Math.sin(lon),(n*(1-e2)+height)*Math.sin(lat)];
}

/** GRS80 tangent plane, x=east, y=up, z=south. Reuse the origin trigonometry. */
export function localFrame(origin:Point):(point:Point)=>Point{
  const base=ecef(origin),p=radians(origin[0]),l=radians(origin[1]);
  const sp=Math.sin(p),cp=Math.cos(p),sl=Math.sin(l),cl=Math.cos(l);
  return point=>{
    if(!point.every(Number.isFinite)||Math.abs(point[0])>90||Math.abs(point[1])>180)throw new Error("COORDINATES_REJECTED");
    const v=ecef(point),dx=v[0]-base[0],dy=v[1]-base[1],dz=v[2]-base[2];
    return [round(-sl*dx+cl*dy),round(cp*cl*dx+cp*sl*dy+sp*dz),round(sp*cl*dx+sp*sl*dy-cp*dz)];
  };
}

export function triangulateRings(rings:Point[][]):{points:Point[];indices:number[]}{
  const outer=rings[0];if(!outer||rings.some(r=>r.length<3||r.length>2000))throw new Error("GEOMETRY_UNSUPPORTED");
  const normal:Point=[0,0,0];
  for(let j=0;j<outer.length;j++){
    const a=outer[j]!,b=outer[(j+1)%outer.length]!;
    for(let i=0;i<3;i++)normal[i]!+=(a[(i+1)%3]!-b[(i+1)%3]!)*(a[(i+2)%3]!+b[(i+2)%3]!);
  }
  const length=Math.hypot(...normal);if(length<1e-6)throw new Error("GEOMETRY_UNSUPPORTED");
  const points=rings.flat(),base=outer[0]!;
  if(points.some(p=>Math.abs(p.reduce((sum,v,i)=>sum+(v-base[i]!)*normal[i]!/length,0))>.05))throw new Error("NON_PLANAR_GEOMETRY");
  const omit=normal.reduce((best,v,i)=>Math.abs(v)>Math.abs(normal[best]!)?i:best,0);
  const flat=points.flatMap(p=>p.filter((_,i)=>i!==omit));
  const holes:number[]=[];let count=0;
  for(const ring of rings){if(count)holes.push(count);count+=ring.length;}
  const indices=earcut(flat,holes,2);
  const areas:number[]=[];let start=0;
  for(const ring of rings){
    let area=0;
    for(let i=0;i<ring.length;i++){const a=(start+i)*2,b=(start+(i+1)%ring.length)*2;area+=flat[a]!*flat[b+1]!-flat[b]!*flat[a+1]!;}
    areas.push(Math.abs(area)/2);start+=ring.length;
  }
  const target=areas[0]!-areas.slice(1).reduce((s,v)=>s+v,0);let actual=0;
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]!*2,b=indices[i+1]!*2,c=indices[i+2]!*2;
    actual+=Math.abs((flat[b]!-flat[a]!)*(flat[c+1]!-flat[a+1]!)-(flat[b+1]!-flat[a+1]!)*(flat[c]!-flat[a]!))/2;
  }
  if(target<=0||Math.abs(actual-target)>Math.max(.001,target*1e-5))throw new Error("TRIANGULATION_AREA_MISMATCH");
  return {points,indices};
}
