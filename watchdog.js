const axios = require("axios");
const http = require("http");

/* ===================== CONFIG ===================== */
const PANEL_URL = process.env.PANEL_URL;
const APP_API_KEY = process.env.API_KEY;
const SERVERS = process.env.SERVERS?.split(",") || [];
const CLIENT_KEYS_RAW = process.env.CLIENT_KEYS || "";
const KILL_AFTER_SECONDS = Number(process.env.KILL_AFTER_SECONDS || 60);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 5);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTHCHECK_PORT = Number(process.env.HEALTHCHECK_PORT || 3000);

/* ===================== VALIDATION ===================== */
if (!PANEL_URL || !APP_API_KEY || SERVERS.length === 0) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/*
CLIENT_KEYS format:
serverId:ptlc_xxx,serverId2:ptlc_yyy
*/
const CLIENT_KEYS = Object.fromEntries(
  CLIENT_KEYS_RAW
    .split(",")
    .filter(Boolean)
    .map(entry => entry.split(":"))
);

// 🔥 Strict validation: ensure every server has a client key
const missingKeys = SERVERS.filter(id => !CLIENT_KEYS[id]);

if (missingKeys.length > 0) {
  console.error(
    "❌ Missing CLIENT_KEYS for the following servers:",
    missingKeys.join(", ")
  );
  process.exit(1);
}

/* ===================== API CLIENTS ===================== */
const appApi = axios.create({
  baseURL: `${PANEL_URL}/api/application`,
  headers: {
    Authorization: `Bearer ${APP_API_KEY}`,
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

  const res = await appApi.get(`/servers/${serverId}`);
  const name = res.data.attributes.name;

  serverNames.set(serverId, name);
  return name;
}

async function getServerState(serverId) {
  const res = await appApi.get(`/servers/${serverId}/resources`);
  return res.data.attributes.current_state;
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
  const clientKey = CLIENT_KEYS[serverId];

  console.log(`[${name} | ${serverId}] 💀 Force killing server`);

  await axios.post(
    `${PANEL_URL}/api/client/servers/${serverId}/power`,
    { signal: "kill" },
    {
      headers: {
        Authorization: `Bearer ${clientKey}`,
        Accept: "Application/vnd.pterodactyl.v1+json",
        "Content-Type": "application/json"
      }
    }
  );

  await sendDiscord(
    `💀 **Server Force Killed**\n` +
    `🖥 **Name:** ${name}\n` +
    `🆔 **ID:** \`${serverId}\`\n` +
    `⏱ **Timeout:** ${KILL_AFTER_SECONDS}s`
  );
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