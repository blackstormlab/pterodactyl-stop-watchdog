const axios = require("axios");
const http = require("http");

/* ===================== CONFIG ===================== */
const PANEL_URL = process.env.PANEL_URL;
const CLIENT_KEY = process.env.CLIENT_KEY;
const SERVERS = process.env.SERVERS?.split(",") || [];
const KILL_AFTER_SECONDS = Number(process.env.KILL_AFTER_SECONDS || 60);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 5);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTHCHECK_PORT = Number(process.env.HEALTHCHECK_PORT || 3000);

/* ===================== VALIDATION ===================== */
if (!PANEL_URL || !SERVERS.length || !CLIENT_KEY) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/* ===================== API CLIENT ===================== */
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
  const res = await clientApi.get(`/servers/${serverId}`);
  return res.data.attributes.status; // "running", "offline", "stopping", etc.
}

/* ===================== DISCORD ===================== */
async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: message });
  } catch (err) {
    console.error("⚠ Discord webhook failed:", err.message);
  }
}

/* ===================== POWER (CLIENT API) ===================== */
async function sendKill(serverId) {
  const name = await getServerName(serverId);

  console.log(`[${name} | ${serverId}] 💀 Force killing server`);

  try {
    await clientApi.post(`/servers/${serverId}/power`, { signal: "kill" });

    await sendDiscord(
      `💀 **Server Force Killed**\n` +
      `🖥 **Name:** ${name}\n` +
      `🆔 **ID:** \`${serverId}\`\n` +
      `⏱ **Timeout:** ${KILL_AFTER_SECONDS}s`
    );
  } catch (err) {
    logApiError(err);
  }
}

/* ===================== API DEBUG ===================== */
function logApiError(err) {
  if (err.response) {
    console.error("Request failed:", err.response.status);
    console.error("Method:", err.response.config.method);
    console.error("URL:", err.response.config.url);
    console.error("Response body:", err.response.data);
  } else {
    console.error("Error:", err.message);
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
http
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

/* ===================== START ===================== */
console.log("🛡 Pterodactyl Stop Watchdog started");

setInterval(async () => {
  try {
    await loop();
  } catch (err) {
    console.error("❌ Loop error:", err.message);
  }
}, CHECK_INTERVAL * 1000);