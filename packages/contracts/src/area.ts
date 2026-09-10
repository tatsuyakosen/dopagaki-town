import { z } from "zod";

export const AreaTileSchema=z.object({
  latitude:z.number().finite().min(20).max(46),longitude:z.number().finite().min(122).max(154),
  x:z.number().int().min(-2).max(2),z:z.number().int().min(-2).max(2),
}).strict();
export type AreaTile=z.infer<typeof AreaTileSchema>;
export type Bounds={minX:number;maxX:number;minZ:number;maxZ:number};
export const tileKey=(x:number,z:number):string=>`${x},${z}`;
export function tileBounds(tile:Pick<AreaTile,"x"|"z">):Bounds {
  return {minX:Math.max(-500,tile.x*250-125),maxX:Math.min(500,tile.x*250+125),
    minZ:Math.max(-500,tile.z*250-125),maxZ:Math.min(500,tile.z*250+125)};
}
export function areaTileAt(x:number,z:number):{x:number;z:number} {
  return {x:Math.max(-2,Math.min(2,Math.floor((x+125)/250))),z:Math.max(-2,Math.min(2,Math.floor((z+125)/250)))};
}
/** GRS80 radii; only used for bounded catalog searches and DEM lookup, not model placement. */
export function offsetCoordinates(latitude:number,longitude:number,east:number,south:number):{latitude:number;longitude:number} {
  const lat=latitude*Math.PI/180,e2=6.6943800229e-3,w=Math.sqrt(1-e2*Math.sin(lat)**2);
  return {latitude:latitude-south/(6378137*(1-e2)/(w*w*w))*180/Math.PI,
    longitude:longitude+east/(6378137/w*Math.cos(lat))*180/Math.PI};
}
export function tileCoordinates(tile:AreaTile):{latitude:number;longitude:number} {
  return offsetCoordinates(tile.latitude,tile.longitude,tile.x*250,tile.z*250);
}
