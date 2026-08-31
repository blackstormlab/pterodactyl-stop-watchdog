const axios = require("axios");
const http = require("http");
const https = require("https");

/* ===================== CONFIG ===================== */
const PANEL_URL = process.env.PANEL_URL;
const CLIENT_KEY = process.env.CLIENT_KEY;

const SERVERS =
  process.env.SERVERS
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean) || [];

const KILL_AFTER_SECONDS = Number(
  process.env.KILL_AFTER_SECONDS || 60
);

const CHECK_INTERVAL = Number(
  process.env.CHECK_INTERVAL || 5
);

const FORCE_KILL_GRACE_SECONDS = Number(
  process.env.FORCE_KILL_GRACE_SECONDS || 30
);

const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL;

const HEALTHCHECK_PORT = Number(
  process.env.HEALTHCHECK_PORT || 3000
);

/* ===================== VALIDATION ===================== */
if (!PANEL_URL || !CLIENT_KEY || !SERVERS.length) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/* ===================== HTTP AGENTS ===================== */

/*
 * Keep Pterodactyl and Discord connections separate.
 * This prevents the Discord requests from sharing
 * the same socket pool as the Pterodactyl API.
 */

const pterodactylAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,
  maxFreeSockets: 2,
  timeout: 30000
});

const discordAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 2,
  maxFreeSockets: 1,
  timeout: 30000
});

/* ===================== CLIENT API ===================== */

const clientApi = axios.create({
  baseURL: `${PANEL_URL}/api/client`,
  httpsAgent: pterodactylAgent,

  // Prevent requests from hanging forever.
  timeout: 10000,

  headers: {
    Authorization: `Bearer ${CLIENT_KEY}`,
    Accept: "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json"
  }
});

/* ===================== DISCORD API ===================== */

const discordApi = axios.create({
  httpsAgent: discordAgent,
  timeout: 10000,

  headers: {
    "Content-Type": "application/json"
  }
});

/* ===================== STATE ===================== */

const stopTimers = new Map();
const serverNames = new Map();
const forceKilled = new Map();

let lastLoopSuccess = Date.now();
let httpServer;
let shuttingDown = false;

/* ===================== HELPERS ===================== */

async function getServerName(serverId) {
  if (serverNames.has(serverId)) {
    return serverNames.get(serverId);
  }

  const res = await clientApi.get(
    `/servers/${serverId}`
  );

  const name = res.data.attributes.name;

  serverNames.set(serverId, name);

  return name;
}

async function getServerState(serverId) {
  /*
   * The client resources endpoint provides the
   * accurate current server state.
   */
  const res = await clientApi.get(
    `/servers/${serverId}/resources`
  );

  return res.data.attributes.current_state;
}

function isInForceKillGrace(serverId) {
  if (!forceKilled.has(serverId)) {
    return false;
  }

  const elapsed =
    (Date.now() - forceKilled.get(serverId)) / 1000;

  if (elapsed > FORCE_KILL_GRACE_SECONDS) {
    forceKilled.delete(serverId);
    return false;
  }

  return true;
}

function sleep(seconds) {
  return new Promise(resolve => {
    setTimeout(resolve, seconds * 1000);
  });
}

/* ===================== DISCORD ===================== */

async function sendDiscordEmbed({
  title,
  color,
  fields
}) {
  if (!DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    await discordApi.post(
      DISCORD_WEBHOOK_URL,
      {
        embeds: [
          {
            title,
            color,
            fields,

            footer: {
              text: "Pterodactyl Stop Watchdog"
            },

            timestamp:
              new Date().toISOString()
          }
        ]
      }
    );
  } catch (err) {
    console.error(
      "⚠ Discord webhook failed:",
      err.message
    );
  }
}

/* ===================== POWER ===================== */

async function sendKill(serverId) {
  const name = await getServerName(serverId);

  console.log(
    `[${name} | ${serverId}] 💀 Force killing server`
  );

  try {
    await clientApi.post(
      `/servers/${serverId}/power`,
      {
        signal: "kill"
      }
    );

    /*
     * Record when the force kill happened.
     * This prevents the resulting offline state
     * from being reported as a normal stop.
     */
    forceKilled.set(
      serverId,
      Date.now()
    );

    await sendDiscordEmbed({
      title: ":dizzy_face: Server Force Killed",
      color: 15548997,

      fields: [
        {
          name: "Server",
          value: name,
          inline: true
        },

        {
          name: "Server ID",
          value: `\`${serverId}\``,
          inline: true
        },

        {
          name: "Reason",
          value:
            `Server did not stop within ` +
            `${KILL_AFTER_SECONDS} seconds`
        }
      ]
    });

  } catch (err) {
    if (err.response) {
      console.error(
        "Request failed:",
        err.response.status
      );

      console.error(
        "Method:",
        err.response.config.method
      );

      console.error(
        "URL:",
        err.response.config.url
      );

      console.error(
        "Response body:",
        err.response.data
      );

    } else {
      console.error(
        "Error:",
        err.message
      );
    }
  }
}

/* ===================== WATCHDOG ===================== */

async function monitorServer(serverId) {
  const state =
    await getServerState(serverId);

  const name =
    await getServerName(serverId);

  /*
   * Server has entered stopping state.
   */
  if (
    state === "stopping" &&
    !stopTimers.has(serverId) &&
    !isInForceKillGrace(serverId)
  ) {
    console.log(
      `[${name} | ${serverId}] ` +
      `⏳ Stop detected, starting ` +
      `${KILL_AFTER_SECONDS}s timer`
    );

    await sendDiscordEmbed({
      title: ":timer: Stop Detected",
      color: 16753920,

      fields: [
        {
          name: "Server",
          value: name,
          inline: true
        },

        {
          name: "Server ID",
          value: `\`${serverId}\``,
          inline: true
        },

        {
          name: "Kill Timeout",
          value:
            `${KILL_AFTER_SECONDS} seconds`
        }
      ]
    });

    const timer = setTimeout(
      async () => {
        try {
          const current =
            await getServerState(serverId);

          if (current !== "offline") {
            await sendKill(serverId);
          }

        } catch (err) {
          console.error(
            `[${name} | ${serverId}] ` +
            `❌ Kill check failed:`,
            err.message
          );

        } finally {
          stopTimers.delete(serverId);
        }
      },
      KILL_AFTER_SECONDS * 1000
    );

    stopTimers.set(
      serverId,
      timer
    );
  }

  /*
   * Server has reached offline state.
   */
  if (
    state === "offline" &&
    stopTimers.has(serverId)
  ) {

    /*
     * If the server was force killed,
     * suppress the normal stop notification.
     */
    if (isInForceKillGrace(serverId)) {
      console.log(
        `[${name} | ${serverId}] ` +
        `🧊 Offline after force kill ` +
        `(grace period)`
      );

      clearTimeout(
        stopTimers.get(serverId)
      );

      stopTimers.delete(serverId);

      return;
    }

    console.log(
      `[${name} | ${serverId}] ` +
      `✅ Stopped normally`
    );

    await sendDiscordEmbed({
      title: "✅ Server Stopped Normally",
      color: 5763719,

      fields: [
        {
          name: "Server",
          value: name,
          inline: true
        },

        {
          name: "Server ID",
          value: `\`${serverId}\``,
          inline: true
        }
      ]
    });

    clearTimeout(
      stopTimers.get(serverId)
    );

    stopTimers.delete(serverId);
  }
}

/* ===================== LOOP ===================== */

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

      const healthy =
        Date.now() - lastLoopSuccess <
        CHECK_INTERVAL * 3000;

      res.writeHead(
        healthy ? 200 : 500
      );

      res.end(
        healthy ? "OK" : "STALE"
      );

      return;
    }

    res.writeHead(404);
    res.end();
  })
  .listen(
    HEALTHCHECK_PORT,
    () => {
      console.log(
        `❤️ Healthcheck listening on ` +
        `:${HEALTHCHECK_PORT}/health`
      );
    }
  );

/* ===================== GRACEFUL SHUTDOWN ===================== */

function shutdown(signal) {

  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `🛑 Received ${signal}, ` +
    `shutting down gracefully`
  );

  /*
   * Cancel all pending stop timers.
   */
  for (const timer of stopTimers.values()) {
    clearTimeout(timer);
  }

  stopTimers.clear();

  /*
   * Stop accepting healthcheck requests.
   */
  if (httpServer) {
    httpServer.close(() => {

      /*
       * Destroy HTTP connections after
       * the server has closed.
       */
      pterodactylAgent.destroy();
      discordAgent.destroy();

      process.exit(0);
    });

  } else {
    pterodactylAgent.destroy();
    discordAgent.destroy();

    process.exit(0);
  }
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

/* ===================== START ===================== */

console.log(
  "🛡 Pterodactyl Stop Watchdog started"
);

console.log(
  `⏱ Kill timeout: ${KILL_AFTER_SECONDS}s`
);

console.log(
  `🔄 Check interval: ${CHECK_INTERVAL}s`
);

console.log(
  `🧊 Force-kill grace period: ` +
  `${FORCE_KILL_GRACE_SECONDS}s`
);

async function startLoop() {

  while (!shuttingDown) {

    const start = Date.now();

    try {
      await loop();

    } catch (err) {
      console.error(
        "❌ Loop error:",
        err.message
      );
    }

    /*
     * Wait CHECK_INTERVAL seconds AFTER
     * the previous loop has finished.
     *
     * This means loops can never overlap.
     */
    const elapsed =
      (Date.now() - start) / 1000;

    const delay =
      Math.max(
        0,
        CHECK_INTERVAL - elapsed
      );

    if (delay > 0) {
      await sleep(delay);
    }
  }
}

startLoop();