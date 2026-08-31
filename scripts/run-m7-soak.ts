import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const values: { matches: number; preset: string; durationMs: number; sampleMs: number; progressMs: number } = {
  matches: 20,
  preset: "LOW",
  durationMs: 600_000,
  sampleMs: 10_000,
  progressMs: 60_000,
};
const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === undefined) continue;
  const [flag, inlineValue] = argument.split("=", 2);
  const value = inlineValue ?? args[index + 1];
  if (inlineValue === undefined) index += 1;
  if (value === undefined) throw new Error(`${flag} requires a value`);
  if (flag === "--matches") values.matches = positiveInteger(flag, value);
  else if (flag === "--preset") values.preset = value.toUpperCase();
  else if (flag === "--duration-ms") values.durationMs = positiveInteger(flag, value);
  else if (flag === "--sample-ms") values.sampleMs = positiveInteger(flag, value);
  else if (flag === "--progress-ms") values.progressMs = positiveInteger(flag, value);
  else throw new Error(`Unknown soak option: ${flag}`);
}

if (values.preset !== "LOW") throw new Error("Only the LOW render preset is supported by the local M7 gate");
if (values.sampleMs > values.durationMs) throw new Error("--sample-ms must not exceed --duration-ms");

const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, [playwrightCli, "test", "--config", "playwright.m7-soak.config.ts"], {
    env: {
      ...process.env,
      SOAK_MATCHES: String(values.matches),
      SOAK_PRESET: values.preset,
      SOAK_MATCH_DURATION_MS: String(values.durationMs),
      SOAK_SAMPLE_MS: String(values.sampleMs),
      SOAK_PROGRESS_MS: String(values.progressMs),
    },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

process.exitCode = exitCode;

function positiveInteger(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
