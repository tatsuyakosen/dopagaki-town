import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Keep the match server and forward preview flags to Vite without a shell.
const children=[
  spawn(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),"watch","apps/match-server/src/index.ts"],{stdio:"inherit"}),
  spawn(process.execPath,[resolve("node_modules/vite/bin/vite.js"),"--config","apps/game-client/vite.config.ts",...process.argv.slice(2)],{stdio:"inherit"}),
];
let stopping=false;
function stop(code:number):void{if(stopping)return;stopping=true;for(const child of children)child.kill("SIGTERM");process.exitCode=code;}
for(const child of children){child.on("error",()=>stop(1));child.on("exit",code=>stop(code??0));}
process.on("SIGINT",()=>stop(0));process.on("SIGTERM",()=>stop(0));
