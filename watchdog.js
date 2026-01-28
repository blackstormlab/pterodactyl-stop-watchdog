const axios = require("axios");
const http = require("http");

/* ===================== CONFIG ===================== */
const PANEL_URL = process.env.PANEL_URL;
const CLIENT_KEY = process.env.CLIENT_KEY;
const SERVERS = process.env.SERVERS?.split(",").map(s => s.trim()).filter(Boolean) || [];
const KILL_AFTER_SECONDS = Number(process.env.KILL_AFTER_SECONDS || 60);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 5);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTHCHECK_PORT = Number(process.env.HEALTHCHECK_PORT || 3000);

/* ===================== VALIDATION ===================== */
if (!PANEL_URL || !CLIENT_KEY || !SERVERS.length) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/* ===================== CLIENT API ===================== */
const clientApi = axios.create({
  baseURL: `${PANEL_URL}/api/client`,
  headers: {
    Authorization: `Bearer ${CLIENT_KEY}`,
    Accept: "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json"
  }
});

/* ===================== STATE ===================== */
const stopTimers = new Map();
const serverNames = new Map();
let lastLoopSuccess = Date.now();
let httpServer;

/* ===================== HELPERS ===================== */
async function getServerName(serverId) {
  if (serverNames.has(serverId)) {
    return serverNames.get(serverId);
  }

  const res = await clientApi.get(`/servers/${serverId}`);
  const name = res.data.attributes.name;

  serverNames.set(serverId, name);
  return name;
}

async function getServerState(serverId) {
  const res = await clientApi.get(`/servers/${serverId}/resources`);
  return res.data.attributes.current_state;
}

/* ===================== DISCORD (EMBEDS) ===================== */
async function sendDiscordEmbed({ title, color, fields }) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [
        {
          title,
          color,
          fields,
          footer: {
            text: "Pterodactyl Stop Watchdog"
          },
          timestamp: new Date().toISOString()
        }
      ]
    });
  } catch (err) {
    console.error("⚠ Discord webhook failed:", err.message);
  }
}

/* ===================== POWER ===================== */
async function sendKill(serverId) {
  const name = await getServerName(serverId);

  console.log(`[${name} | ${serverId}] 💀 Force killing server`);

  try {
    await clientApi.post(`/servers/${serverId}/power`, {
      signal: "kill"
    });

    await sendDiscordEmbed({
      title: "💀 Server Force Killed",
      color: 15548997, // red
      fields: [
        { name: "Server", value: name, inline: true },
        { name: "Server ID", value: `\`${serverId}\``, inline: true },
        {
          name: "Reason",
          value: `Server did not stop within ${KILL_AFTER_SECONDS} seconds`
        }
      ]
    });
  } catch (err) {
    if (err.response) {
      console.error("Request failed:", err.response.status);
      console.error("Method:", err.response.config.method);
      console.error("URL:", err.response.config.url);
      console.error("Response body:", err.response.data);
    } else {
      console.error("Error:", err.message);
    }
  }
}

/* ===================== WATCHDOG ===================== */
async function monitorServer(serverId) {
  const state = await getServerState(serverId);
  const name = await getServerName(serverId);

  if (state === "stopping" && !stopTimers.has(serverId)) {
    console.log(
      `[${name} | ${serverId}] ⏳ Stop detected, starting ${KILL_AFTER_SECONDS}s timer`
    );

    await sendDiscordEmbed({
      title: "⏳ Stop Detected",
      color: 16753920, // orange
      fields: [
        { name: "Server", value: name, inline: true },
        { name: "Server ID", value: `\`${serverId}\``, inline: true },
        {
          name: "Kill Timeout",
          value: `${KILL_AFTER_SECONDS} seconds`
        }
      ]
    });

    const timer = setTimeout(async () => {
      try {
        const current = await getServerState(serverId);
        if (current !== "offline") {
          await sendKill(serverId);
        }
      } catch (err) {
        console.error(`[${name} | ${serverId}] ❌ Kill check failed:`, err.message);
      } finally {
        stopTimers.delete(serverId);
      }
    }, KILL_AFTER_SECONDS * 1000);

    stopTimers.set(serverId, timer);
  }

  if (state === "offline" && stopTimers.has(serverId)) {
    console.log(`[${name} | ${serverId}] ✅ Stopped normally`);

    await sendDiscordEmbed({
      title: "✅ Server Stopped Normally",
      color: 5763719, // green
      fields: [
        { name: "Server", value: name, inline: true },
        { name: "Server ID", value: `\`${serverId}\``, inline: true }
      ]
    });

    clearTimeout(stopTimers.get(serverId));
    stopTimers.delete(serverId);
  }
}

async function loop() {
  for (const serverId of SERVERS) {
    await monitorServer(serverId);
  }
  lastLoopSuccess = Date.now();
}

/* ===================== HEALTHCHECK ===================== */
httpServer = http
  .createServer((req, res) => {
    if (req.url === "/health") {
      const healthy = Date.now() - lastLoopSuccess < CHECK_INTERVAL * 3000;
      res.writeHead(healthy ? 200 : 500);
      res.end(healthy ? "OK" : "STALE");
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(HEALTHCHECK_PORT, () => {
    console.log(`❤️ Healthcheck listening on :${HEALTHCHECK_PORT}/health`);
  });

/* ===================== GRACEFUL SHUTDOWN ===================== */
function shutdown(signal) {
  console.log(`🛑 Received ${signal}, shutting down gracefully`);

  for (const timer of stopTimers.values()) {
    clearTimeout(timer);
  }
  stopTimers.clear();

  if (httpServer) {
    httpServer.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* ===================== START ===================== */
console.log("🛡 Pterodactyl Stop Watchdog started");

setInterval(async () => {
  try {
    await loop();
  } catch (err) {
    console.error("❌ Loop error:", err.message);
  }
}, CHECK_INTERVAL * 1000);