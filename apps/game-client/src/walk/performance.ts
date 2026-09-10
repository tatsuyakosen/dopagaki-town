/** Opt-in local measurement. Never captures URLs, coordinates, identifiers or device names. */
export class WalkPerformance {
  private samples:number[]=[];private elapsed=0;private finished=false;
  private qualities=new Set<string>();private maximumVertices=0;private maximumBlocks=0;private peakJsHeapBytes:number|null=null;
  get seconds():number{return this.elapsed/1000;}
  get complete():boolean{return this.finished;}
  add(frameMs:number,quality:string,vertices:number,blocks:number,jsHeapBytes?:number):void{
    if(this.finished||!Number.isFinite(frameMs)||frameMs<=0)return;
    this.samples.push(frameMs);this.elapsed+=frameMs;this.qualities.add(quality);
    this.maximumVertices=Math.max(this.maximumVertices,vertices);this.maximumBlocks=Math.max(this.maximumBlocks,blocks);
    if(jsHeapBytes!==undefined&&Number.isFinite(jsHeapBytes)&&jsHeapBytes>=0)this.peakJsHeapBytes=Math.max(this.peakJsHeapBytes??0,jsHeapBytes);
    this.finished=this.elapsed>=60_000||this.samples.length>=18_000;
  }
  report(){
    const sorted=[...this.samples].sort((a,b)=>a-b),frames=sorted.length;
    return {version:1,durationSeconds:Number(this.seconds.toFixed(2)),frames,averageFps:this.elapsed?Number((frames*1000/this.elapsed).toFixed(1)):null,
      p95FrameMs:frames?Number(sorted[Math.ceil(frames*.95)-1]!.toFixed(2)):null,framesOver50Ms:sorted.filter(ms=>ms>50).length,
      framesOver100Ms:sorted.filter(ms=>ms>100).length,qualities:[...this.qualities],maximumVertices:this.maximumVertices,
      maximumResidentBlocks:this.maximumBlocks,peakJsHeapBytes:this.peakJsHeapBytes,
      note:"Visible, unpaused gameplay frames only. JS heap is optional and excludes GPU/system memory. This is a browser observation, not a GPU benchmark."};
  }
}
