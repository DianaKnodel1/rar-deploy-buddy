#!/usr/bin/env bun
// Self-hosted Bun-Server für TanStack Start.
// Importiert den gebauten Worker-Handler (export default { fetch })
// aus dist/server/server.js und serviert ihn via Bun.serve().

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const handlerPath = resolve(here, "..", "dist", "server", "server.js");

const mod = await import(handlerPath);
const handler = mod.default ?? mod;

if (typeof handler?.fetch !== "function") {
  console.error("[serve] dist/server/server.js exportiert kein { fetch } default.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

// @ts-ignore — Bun ist im Bun-Runtime global verfügbar.
const server = Bun.serve({
  port,
  hostname,
  // Generous timeout für SSR-Loader.
  idleTimeout: 120,
  fetch: (request) => handler.fetch(request, process.env, {}),
  error: (err) => {
    console.error("[serve] Unhandled fetch error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`[serve] Portal läuft auf http://${server.hostname}:${server.port}`);

// Bun.serve() allein hält in einigen Bun-/systemd-Kombinationen den Prozess
// nicht zuverlässig offen. Ein expliziter Keepalive verhindert Restart-Loops.
const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000);

// Sauberer Shutdown bei SIGTERM/SIGINT (wichtig für systemd).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[serve] ${sig} empfangen — beende Server.`);
    clearInterval(keepAlive);
    server.stop();
    process.exit(0);
  });
}