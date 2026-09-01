import { createDirectorServer } from "./server.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const providerValue = process.env.DIRECTOR_PROVIDER ?? "fixture";
if (providerValue !== "fixture" && providerValue !== "gemini-adk") {
  throw new Error("DIRECTOR_PROVIDER must be fixture or gemini-adk");
}
const provider = providerValue === "gemini-adk" ? "GEMINI_ADK" : "FIXTURE";
const model = process.env.DIRECTOR_MODEL ?? "gemini-flash-latest";
const server = createDirectorServer({ provider, model });

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`DOPAGAKI Director API listening on http://127.0.0.1:${PORT} (${provider})\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
