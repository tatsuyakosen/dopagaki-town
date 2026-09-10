import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 1024 * 1024;
const forbidden = /(^|\/)(\.env(?:\..+)?|\.npmrc|\.venv|credentials[^/]*\.json|[^/]*service-account[^/]*\.json|id_rsa|id_ed25519)(\/|$)|\.(pem|key|p12|pfx|gml|citygml|glb|gltf|b3dm|i3dm|pnts|3tz|zip|7z)$/i;
const runtimeData = /(^|\/)(data\/(raw|processed)|city-data|test-results|playwright-report|artifacts|\.local)(\/|$)/;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/,
  /["']private_key["']\s*:\s*["'][^"']{30,}/,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/,
  /[?&](?:X-Amz-Signature|X-Goog-Signature|sig|access_token)=[A-Za-z0-9%_-]{16,}/i,
];

export function inspectPublishFile(path:string, bytes:Uint8Array):string[] {
  const issues:string[]=[];
  if ((forbidden.test(path) && !/(^|\/)\.env\.example$/.test(path)) || runtimeData.test(path)) issues.push("forbidden-file");
  if (bytes.byteLength>MAX_BYTES) issues.push("oversize-file");
  const text=Buffer.from(bytes).toString("utf8");
  if(/\.txt$/i.test(path)&&text.split(/\r?\n/,2).some(line=>/^(?:-?\d+(?:\.\d+)?|e)(?:,(?:-?\d+(?:\.\d+)?|e)){255}$/.test(line)))issues.push("raw-elevation-data");
  if(secretPatterns.some(pattern=>pattern.test(text)))issues.push("possible-secret");
  // Detect literal secret assignments while allowing environment reads and clear templates.
  const assignments=text.matchAll(/(?:api[_-]?key|secret[_-]?key|password|access[_-]?token)\s*["']?\s*[:=]\s*["']([^"'\n]{12,})["']/gi);
  for(const match of assignments){const value=match[1]??"";if(/^[A-Za-z0-9_./+=-]+$/.test(value)&&!/^(replace|example|dummy|fixture|test|your-|process\.)/i.test(value)&&!/outside-version-control/.test(value))issues.push("possible-secret-assignment");}
  return [...new Set(issues)];
}

export function checkRepository(staged=false, history=false):number {
  const git=(args:string[])=>execFileSync("git",args,{maxBuffer:64*1024*1024});
  let checked=0,failures=0;
  const inspect=(path:string,bytes:Uint8Array)=>{checked++;const issues=inspectPublishFile(path,bytes);if(issues.length){failures++;console.error(`${path}: ${issues.join(", ")} (content redacted)`);}};
  if(history){
    const seen=new Set<string>();
    for(const line of git(["rev-list","--objects","--all"]).toString().trim().split("\n")){
      const split=line.indexOf(" ");if(split<0)continue;const sha=line.slice(0,split),path=line.slice(split+1);
      if(git(["cat-file","-t",sha]).toString().trim()!=="blob"||seen.has(sha))continue;
      seen.add(sha);inspect(path,git(["cat-file","blob",sha]));
    }
  }else{
    const args=staged?["diff","--cached","--name-only","--diff-filter=ACMR","-z"]:["ls-files","--cached","--others","--exclude-standard","-z"];
    const paths=[...new Set(git(args).toString().split("\0").filter(Boolean))];
    for(const path of paths){
      if(staged){
        const entry=git(["ls-files","--stage","--",path]).toString();
        if(entry.startsWith("120000")||entry.startsWith("160000")){failures++;console.error(`${path}: symlink/submodule forbidden`);continue;}
        inspect(path,git(["show",`:${path}`]));continue;
      }
      const stat=lstatSync(path);if(stat.isSymbolicLink()){failures++;console.error(`${path}: symlink forbidden`);continue;}
      inspect(path,readFileSync(path));
    }
  }
  console.log(JSON.stringify({checked,failures,mode:history?"available-history":staged?"staged":"worktree",note:"Heuristic guard; manual review and provider secret scanning are still required."}));
  return failures?1:0;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){process.exitCode=checkRepository(process.argv.includes("--staged"),process.argv.includes("--history"));}
