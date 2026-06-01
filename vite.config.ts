// Self-hosted Build-Konfiguration:
// Wir deaktivieren den Cloudflare-Workers-Plugin (cloudflare: false), damit
// das Projekt als normaler Bun-Server über dist/server/server.js gestartet wird.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  cloudflare: false,
  tanstackStart: {
    // SSR-Entry bleibt unsere eigene src/server.ts (Error-Wrapper).
    server: { entry: "server" },
  },
});
