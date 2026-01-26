const axios = require("axios");
const http = require("http");

const PANEL_URL = process.env.PANEL_URL;
const API_KEY = process.env.API_KEY;
const SERVERS = process.env.SERVERS?.split(",") || [];
const KILL_AFTER_SECONDS = Number(process.env.KILL_AFTER_SECONDS || 60);
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 5);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTHCHECK_PORT = Number(process.env.HEALTHCHECK_PORT || 3000);

if (!PANEL_URL || !API_KEY || SERVERS.length === 0) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const api = axios.create({
  baseURL: `${PANEL_URL}/api/application`,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json"
  }
});

const stopTimers = new Map();
const serverNames = new Map();
let lastLoopSuccess = Date.now();

/* -------------------- HELPERS -------------------- */
async function getServerName(serverId) {
  if (serverNames.has(serverId)) {
    return serverNames.get(serverId);
  }

  const res = await api.get(`/servers/${serverId}`);
  const name = res.data.attributes.name;

  serverNames.set(serverId, name);
  return name;
}

/* -------------------- DISCORD -------------------- */
async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: message });
  } catch (err) {
    console.error("⚠ Discord webhook failed:", err.message);
  }
}

/* -------------------- PTERO -------------------- */
async function getServerState(serverId) {
  const res = await api.get(`/servers/${serverId}/resources`);
  return res.data.attributes.current_state;
}

async function sendKill(serverId) {
  const name = await getServerName(serverId);

  console.log(`[${name} | ${serverId}] 💀 Force killing server`);
  await api.post(`/servers/${serverId}/power`, { signal: "kill" });

  await sendDiscord(
    `💀 **Server Force Killed**\n` +
    `🖥 **Name:** ${name}\n` +
    `🆔 **ID:** \`${serverId}\`\n` +
    `⏱ **Timeout:** ${KILL_AFTER_SECONDS}s`
  );
}

async function monitorServer(serverId) {
  const state = await getServerState(serverId);
  const name = await getServerName(serverId);

  if (state === "stopping" && !stopTimers.has(serverId)) {
    console.log(`[${name} | ${serverId}] ⏳ Stop detected, starting ${KILL_AFTER_SECONDS}s timer`);

    const timer = setTimeout(async () => {
      const current = await getServerState(serverId);
      if (current !== "offline") {
        await sendKill(serverId);
      }
      stopTimers.delete(serverId);
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

/* -------------------- HEALTHCHECK -------------------- */
http.createServer((req, res) => {
  if (req.url === "/health") {
    const healthy = Date.now() - lastLoopSuccess < CHECK_INTERVAL * 3000;
    res.writeHead(healthy ? 200 : 500);
    res.end(healthy ? "OK" : "STALE");
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HEALTHCHECK_PORT, () => {
  console.log(`❤️ Healthcheck listening on :${HEALTHCHECK_PORT}/health`);
});

/* -------------------- START -------------------- */
console.log("🛡 Pterodactyl Stop Watchdog started");
setInterval(async () => {
  try {
    await loop();
  } catch (err) {
    console.error("❌ Loop error:", err.message);
  }
}, CHECK_INTERVAL * 1000);