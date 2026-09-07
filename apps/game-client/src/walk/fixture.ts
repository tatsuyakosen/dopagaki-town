import type { CityManifest, CityMesh } from "@dopagaki/contracts";

// Deliberately fictional. Never used as an automatic fallback for Umeda.
export function boxGeometry(id: string, x: number, z: number, w: number, d: number, height: number): CityMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const corners = [[x-w/2,0,z-d/2],[x+w/2,0,z-d/2],[x+w/2,0,z+d/2],[x-w/2,0,z+d/2],
    [x-w/2,height,z-d/2],[x+w/2,height,z-d/2],[x+w/2,height,z+d/2],[x-w/2,height,z+d/2]];
  for (const face of [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]]) {
    const base = positions.length / 3;
    for (const i of face) positions.push(...(corners[i] ?? []));
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  return { id, kind: "building", positions, indices };
}

export function createFixture(): CityManifest {
  const meshes: CityMesh[] = [{ id:"test-ground", kind:"terrain", positions:[-125,0,-125,125,0,-125,125,0,125,-125,0,125], indices:[0,2,1,0,3,2] }];
  for (let i=0; i<6; i++) {
    const z = -95 + i*35;
    meshes.push(boxGeometry(`test-west-${i}`,-36,z,34,25,18+(i%3)*12));
    meshes.push(boxGeometry(`test-east-${i}`,37,z,36,23,22+((i+1)%4)*9));
    meshes.push(boxGeometry(`test-outer-${i}`,-92,z,30,28,32+(i%2)*17));
  }
  meshes.push({id:"test-road",kind:"road",positions:[-17,.025,-125,17,.025,-125,17,.025,125,-17,.025,125],indices:[0,2,1,0,3,2]});
  return {
    version:1,mode:"fixture",title:"操作検証街区 — 架空のステージ",
    coordinateSystem:"LOCAL_ENU_Y_UP_METERS",origin:{latitude:0,longitude:0,altitude:0},extentMeters:1000,
    playableHalfSize:125,spawn:[0,1.2,50],sources:[],
    limitations:["実都市の形状・位置・地形を再現したデータではありません。", "1km四方の計画範囲のうち、250m四方を想定した操作検証です。", "建物の外装・窓・光・夕景・検証ゲートは架空の演出です。"],meshes,
  };
}
