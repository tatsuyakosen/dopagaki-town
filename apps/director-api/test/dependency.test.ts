import { crc32 } from "node:zlib";
import { describe,expect,it } from "vitest";
import { assertAdkRuntime } from "../src/runtime.js";

/** A single synthetic stored ZIP record, with valid CRC; no archive is checked into Git. */
function skillArchive():Buffer{
  const name=Buffer.from("SKILL.md"),data=Buffer.from("---\nname: synthetic-check\ndescription: Offline dependency compatibility check\n---\nSynthetic instructions.\n");
  const crc=crc32(data),header=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(header.length+name.length+data.length,16);
  return Buffer.concat([header,name,data,central,name,end]);
}

let supported=true;try{assertAdkRuntime(process.versions.node);}catch{supported=false;}
// Node 22 supports the rules mode; CI runs this real ADK check separately on Node 24.
describe.skipIf(!supported)("installed ADK dependency compatibility (offline)",()=>{
  it("loads a skill ZIP through the real ADK after overriding adm-zip",async()=>{
    const {loadSkillFromZipBuffer}=await import("@google/adk");
    const skill=loadSkillFromZipBuffer(skillArchive());
    expect(skill.frontmatter.name).toBe("synthetic-check");expect(skill.instructions).toBe("Synthetic instructions.");
  });
  it("creates the planner agent and an in-memory session without an LLM request",async()=>{
    const {InMemoryRunner,LlmAgent}=await import("@google/adk");
    const agent=new LlmAgent({name:"compatibility_check",model:"synthetic-unused-model",instruction:"Synthetic offline check"});
    const runner=new InMemoryRunner({agent,appName:"dependency-check"});
    const session=await runner.sessionService.createSession({appName:runner.appName,userId:"synthetic-user"});
    expect(session.appName).toBe("dependency-check");expect(session.userId).toBe("synthetic-user");
  });
});
