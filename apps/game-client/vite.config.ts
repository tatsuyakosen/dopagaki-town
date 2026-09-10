import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { createCityHandler } from "../city-builder/src/http.js";
import { attachWalkSocket } from "../match-server/src/walk-socket.js";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [{ name:"local-city-builder",
    configureServer(server){ server.middlewares.use(createCityHandler()); if(server.httpServer)attachWalkSocket(server.httpServer); },
    configurePreviewServer(server){ server.middlewares.use(createCityHandler()); attachWalkSocket(server.httpServer); },
  }],
  server: {
    host: "127.0.0.1",
    allowedHosts: ["terminal.local"],
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    manifest: true,
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL("index.html", import.meta.url)),
        walk: fileURLToPath(new URL("walk.html", import.meta.url)),
        map: fileURLToPath(new URL("map.html", import.meta.url)),
      },
    },
  },
});
