#!/usr/bin/env node
/**
 * aposkal-mcp — Aposkal muhasebe API'si için Model Context Protocol sunucusu.
 * Geliştiren: Switas Consultancy (https://switas.com) · MIT Lisansı
 * https://github.com/switaslabs/aposkal-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { log, registerSecret, setLogLevel } from "./redact.js";
import { createServer } from "./server.js";
import { AUTHOR, VERSION } from "./version.js";

async function main(): Promise<void> {
  // Sırları ilk iş kaydet; yapılandırma hataları bile onları yazdıramasın.
  registerSecret(process.env.APOSKAL_API_KEY?.trim());
  registerSecret(process.env.APOSKAL_API_SECRET?.trim());

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const { server, tools } = createServer(cfg);
  log.info(
    `aposkal-mcp ${VERSION} · ${AUTHOR} · ortam=${cfg.env} mod=${cfg.mode} dış=${cfg.allowExternal} hassas=${cfg.allowSensitive} · ${tools.length} araç`,
  );
  if (cfg.env === "live" && cfg.mode !== "readonly") {
    log.warn(`CANLI Aposkal ortamına "${cfg.mode}" modunda bağlanıldı — değişiklikler gerçek muhasebe verisini etkiler.`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error(err.message + "\nBkz. .env.example veya https://github.com/switaslabs/aposkal-mcp#yapılandırma");
  } else {
    log.error("Kritik hata", err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
});
