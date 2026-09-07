import { createHash } from "node:crypto";
import { SaxesParser, type SaxesTagNS } from "saxes";

export interface XmlNode { local:string; uri:string; attributes:Record<string,string>; children:XmlNode[]; text:string }
export const GML="http://www.opengis.net/gml";
export const CORE="http://www.opengis.net/citygml/2.0";
export const XLINK="http://www.w3.org/1999/xlink";

/** Retain one selected subtree at a time; never resolve DTDs or external entities. */
export async function readXml(
  chunks:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,
  receive:(node:XmlNode)=>void,
  select:(tag:SaxesTagNS)=>boolean=()=>true,
  inspect:(tag:SaxesTagNS)=>void=()=>{},
  limit=128*1024*1024,
):Promise<string> {
  const parser=new SaxesParser({xmlns:true});
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const digest=createHash("sha256");
  const stack:XmlNode[]=[];
  let bytes=0,depth=0,nodes=0,textBytes=0,tail="";
  parser.on("error",()=>{throw new Error("XML_REJECTED");});
  parser.on("doctype",()=>{throw new Error("XML_REJECTED");});
  parser.on("xmldecl",value=>{if(value.encoding&&!/^utf-8$/i.test(value.encoding))throw new Error("XML_REJECTED");});
  parser.on("opentag",tag=>{
    if(++depth>128)throw new Error("XML_BUDGET");
    inspect(tag);
    if(!stack.length&&!select(tag))return;
    if(!stack.length){nodes=0;textBytes=0;}
    if(++nodes>200_000)throw new Error("XML_BUDGET");
    const attributes:Record<string,string>={};
    for(const a of Object.values(tag.attributes))attributes[a.uri?`{${a.uri}}${a.local}`:a.local]=a.value;
    const node:XmlNode={local:tag.local,uri:tag.uri,attributes,children:[],text:""};
    stack.at(-1)?.children.push(node);stack.push(node);
  });
  const text=(value:string)=>{
    const node=stack.at(-1);if(!node)return;
    textBytes+=Buffer.byteLength(value);if(textBytes>8*1024*1024)throw new Error("XML_BUDGET");
    node.text+=value;
  };
  parser.on("text",text);parser.on("cdata",text);
  parser.on("closetag",()=>{depth--;const node=stack.pop();if(node&&!stack.length)receive(node);});
  for await(const chunk of chunks){
    bytes+=chunk.length;if(bytes>limit)throw new Error("SOURCE_TOO_LARGE");
    digest.update(chunk);
    const decoded=decoder.decode(chunk,{stream:true});
    const checked=(tail+decoded).toUpperCase();
    if(checked.includes("\0")||checked.includes("<!DOCTYPE")||checked.includes("<!ENTITY"))throw new Error("XML_REJECTED");
    tail=checked.slice(-16);parser.write(decoded);
  }
  parser.write(decoder.decode()).close();return digest.digest("hex");
}

export function* descendants(node:XmlNode):Generator<XmlNode>{yield node;for(const child of node.children)yield* descendants(child);}
export const child=(node:XmlNode|undefined,local:string,uri=GML):XmlNode|undefined=>node?.children.find(n=>n.local===local&&n.uri===uri);
export const content=(node:XmlNode):string=>node.text+node.children.map(content).join("");
