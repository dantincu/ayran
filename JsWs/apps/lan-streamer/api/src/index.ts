import { existsSync, mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import cors from "cors";
import express from "express";
import { handleUpgrade } from "./audio/ws-handlers.js";
import { router } from "./routes.js";
import { loadStreams } from "./store.js";
import { ensureDevCertificate } from "./tls.js";

const PORT = Number(process.env.PORT ?? 8443);
const CERT_DIR = path.resolve(process.cwd(), "certs");

async function main(): Promise<void> {
  await loadStreams();

  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });
  const { keyPath, certPath } = await ensureDevCertificate(CERT_DIR);

  const app = express();
  // Clients are Tauri desktop/mobile apps (arbitrary dev-server or app:// origins),
  // not browser pages we need to restrict; auth is enforced via Filen login + bearer
  // token, not by origin, so reflecting the request origin is fine here.
  app.use(cors({ origin: true }));
  app.use(express.json());
  app.use("/api", router);

  const server = https.createServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    app,
  );

  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/ws/")) {
      handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`LAN Streamer API listening on https://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
