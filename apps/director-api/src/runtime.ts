export function assertAdkRuntime(version:string):void {
  const [major=0,minor=0]=version.split(".").map(Number);
  if(major<24 || (major===24 && minor<13))throw new Error("Gemini ADK mode requires Node.js 24.13 or newer");
}
