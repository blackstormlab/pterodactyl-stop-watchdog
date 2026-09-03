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
  console.error(
    "❌ Missing required environment variables"
  );

  process.exit(1);
}

if (
  !Number.isFinite(KILL_AFTER_SECONDS) ||
  KILL_AFTER_SECONDS <= 0
) {
  console.error(
    "❌ KILL_AFTER_SECONDS must be greater than 0"
  );

  process.exit(1);
}

if (
  !Number.isFinite(CHECK_INTERVAL) ||
  CHECK_INTERVAL <= 0
) {
  console.error(
    "❌ CHECK_INTERVAL must be greater than 0"
  );

  process.exit(1);
}

if (
  !Number.isFinite(FORCE_KILL_GRACE_SECONDS) ||
  FORCE_KILL_GRACE_SECONDS <= 0
) {
  console.error(
    "❌ FORCE_KILL_GRACE_SECONDS must be greater than 0"
  );

  process.exit(1);
}

/* ===================== HTTP AGENTS ===================== */

/*
 * Keep-alive is intentionally disabled.
 *
 * The watchdog makes relatively few requests, so there is
 * little benefit from keeping persistent TLS connections alive.
 *
 * This also avoids long-lived socket/listener accumulation.
 */

const pterodactylAgent = new https.Agent({
  keepAlive: false
});

const discordAgent = new https.Agent({
  keepAlive: false
});

/* ===================== CLIENT API ===================== */

const clientApi = axios.create({
  baseURL: `${PANEL_URL}/api/client`,

  httpsAgent: pterodactylAgent,

  // Prevent requests from hanging indefinitely.
  timeout: 10000,

  /*
   * Pterodactyl API requests should not require redirects.
   */
  maxRedirects: 0,

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

  /*
   * Discord webhook URLs should not require redirects.
   */
  maxRedirects: 0,

  headers: {
    "Content-Type": "application/json"
  }
});

/* ===================== STATE ===================== */

/*
 * Stop timers.
 *
 * serverId -> Timeout
 */
const stopTimers = new Map();

/*
 * Cached server names.
 *
 * serverId -> name
 */
const serverNames = new Map();

/*
 * Explicit watchdog state.
 *
 * serverId -> {
 *   state: "stopping" | "force-killing",
 *   since: number
 * }
 *
 * This is intentionally separate from the Pterodactyl
 * server state.
 *
 * It tells us what CAUSED the transition.
 */
const watchdogStates = new Map();

let lastLoopSuccess = Date.now();

let httpServer;

let shuttingDown = false;

/* ===================== HELPERS ===================== */

async function getServerName(serverId) {
  /*
   * Server names are cached so we don't request the
   * server information on every watchdog cycle.
   */
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
   * The resources endpoint provides the current
   * server state.
   */
  const res = await clientApi.get(
    `/servers/${serverId}/resources`
  );

  return res.data.attributes.current_state;
}

function getWatchdogState(serverId) {
  return watchdogStates.get(serverId);
}

function setWatchdogState(serverId, state) {
  watchdogStates.set(serverId, {
    state,
    since: Date.now()
  });
}

function clearWatchdogState(serverId) {
  watchdogStates.delete(serverId);
}

function clearStopTimer(serverId) {
  const timer = stopTimers.get(serverId);

  if (timer) {
    clearTimeout(timer);
    stopTimers.delete(serverId);
  }
}

function isForceKilling(serverId) {
  const state = getWatchdogState(serverId);

  return (
    state &&
    state.state === "force-killing"
  );
}

/*
 * Returns true if the server is currently inside
 * the force-kill grace period.
 *
 * This is retained as an additional safety check,
 * but the explicit watchdog state is the primary
 * source of truth.
 */
function isInForceKillGrace(serverId) {
  const state = getWatchdogState(serverId);

  if (
    !state ||
    state.state !== "force-killing"
  ) {
    return false;
  }

  const elapsed =
    (Date.now() - state.since) / 1000;

  if (
    elapsed > FORCE_KILL_GRACE_SECONDS
  ) {
    /*
     * Grace period has expired.
     *
     * We can forget the force-kill state.
     */
    clearWatchdogState(serverId);

    return false;
  }

  return true;
}

function sleep(seconds) {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      seconds * 1000
    );
  });
}

/* ===================== ERROR LOGGING ===================== */

function logAxiosError(prefix, err) {
  if (err.response) {
    console.error(
      `${prefix} Request failed:`,
      err.response.status
    );

    console.error(
      `${prefix} Method:`,
      err.response.config?.method
    );

    console.error(
      `${prefix} URL:`,
      err.response.config?.url
    );

    console.error(
      `${prefix} Response body:`,
      err.response.data
    );

    return;
  }

  console.error(
    `${prefix}`,
    err.message
  );
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
  const name =
    await getServerName(serverId);

  console.log(
    `[${name} | ${serverId}] 💀 Force killing server`
  );

  /*
   * IMPORTANT:
   *
   * Record the force-kill state BEFORE sending
   * the API request.
   *
   * Pterodactyl may transition the server to
   * offline extremely quickly. Recording the state
   * first prevents a race where the watchdog sees
   * "offline" before forceKilled was recorded.
   */
  setWatchdogState(
    serverId,
    "force-killing"
  );

  try {
    await clientApi.post(
      `/servers/${serverId}/power`,
      {
        signal: "kill"
      }
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
    /*
     * The kill request failed.
     *
     * Do NOT leave the server marked as
     * force-killed or a later offline state
     * could be incorrectly suppressed.
     */
    clearWatchdogState(serverId);

    logAxiosError(
      `[${name} | ${serverId}]`,
      err
    );
  }
}

/* ===================== STOP TIMER ===================== */

function startStopTimer(
  serverId,
  name
) {
  /*
   * Never create a second timer for the same server.
   */
  if (stopTimers.has(serverId)) {
    return;
  }

  console.log(
    `[${name} | ${serverId}] ` +
    `⏳ Stop detected, starting ` +
    `${KILL_AFTER_SECONDS}s timer`
  );

  const timer = setTimeout(
    async () => {
      /*
       * Remove the timer immediately.
       *
       * The watchdog state remains responsible for
       * tracking what happens after this point.
       */
      stopTimers.delete(serverId);

      if (shuttingDown) {
        return;
      }

      try {
        const current =
          await getServerState(serverId);

        /*
         * The server stopped normally before the
         * timeout expired.
         */
        if (current === "offline") {
          console.log(
            `[${name} | ${serverId}] ` +
            `✅ Server became offline before ` +
            `force kill`
          );

          return;
        }

        /*
         * The server is still not offline.
         *
         * Enter force-killing state and send kill.
         */
        await sendKill(serverId);

      } catch (err) {
        console.error(
          `[${name} | ${serverId}] ` +
          `❌ Kill check failed:`,
          err.message
        );
      }
    },
    KILL_AFTER_SECONDS * 1000
  );

  stopTimers.set(
    serverId,
    timer
  );
}

/* ===================== WATCHDOG ===================== */

async function monitorServer(serverId) {
  const state =
    await getServerState(serverId);

  const name =
    await getServerName(serverId);

  const watchdogState =
    getWatchdogState(serverId);

  /*
   * =====================================================
   * FORCE-KILLING
   * =====================================================
   *
   * If we previously initiated a force kill, an offline
   * state during the grace period is NOT a normal stop.
   */
  if (
    state === "offline" &&
    isForceKilling(serverId)
  ) {
    console.log(
      `[${name} | ${serverId}] ` +
      `🧊 Offline after force kill ` +
      `(grace period)`
    );

    clearStopTimer(serverId);

    /*
     * Keep the force-killing state alive until the
     * grace period expires. This prevents another
     * "stopping" event immediately after the kill
     * from starting a new timer.
     */
    return;
  }

  /*
   * =====================================================
   * FORCE-KILL GRACE EXPIRED
   * =====================================================
   *
   * If the server is offline and the force-kill state
   * has expired, clear the state.
   */
  if (
    state === "offline" &&
    watchdogState?.state === "force-killing"
  ) {
    clearWatchdogState(serverId);
  }

  /*
   * =====================================================
   * STOPPING DETECTED
   * =====================================================
   */

  if (
    state === "stopping" &&
    !stopTimers.has(serverId) &&
    !isForceKilling(serverId)
  ) {
    /*
     * Record that this server is currently undergoing
     * a normal stop operation.
     */
    setWatchdogState(
      serverId,
      "stopping"
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

    startStopTimer(
      serverId,
      name
    );

    return;
  }

  /*
   * =====================================================
   * NORMAL OFFLINE
   * =====================================================
   */

  if (state === "offline") {
    /*
     * If there is no active stop operation, there is
     * nothing to report.
     */
    if (
      !stopTimers.has(serverId) &&
      !watchdogState
    ) {
      return;
    }

    /*
     * If this was our force kill, suppress the normal
     * stop notification.
     */
    if (isInForceKillGrace(serverId)) {
      console.log(
        `[${name} | ${serverId}] ` +
        `🧊 Offline after force kill ` +
        `(grace period)`
      );

      clearStopTimer(serverId);

      return;
    }

    /*
     * If we reach this point with a normal stopping
     * state, the server stopped on its own.
     */
    if (
      watchdogState?.state === "stopping" ||
      stopTimers.has(serverId)
    ) {
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
    }

    clearStopTimer(serverId);
    clearWatchdogState(serverId);

    return;
  }

  /*
   * =====================================================
   * SERVER LEFT STOPPING STATE
   * =====================================================
   *
   * If a server was stopping but then changes to another
   * active state, cancel the pending timer.
   *
   * Example:
   *
   * stopping → starting → running
   *
   * This means the stop operation was cancelled.
   */
  if (
    watchdogState?.state === "stopping" &&
    state !== "stopping"
  ) {
    console.log(
      `[${name} | ${serverId}] ` +
      `↩️ Stop state cancelled ` +
      `(current state: ${state})`
    );

    clearStopTimer(serverId);
    clearWatchdogState(serverId);
  }
}

/* ===================== WATCHDOG LOOP ===================== */

async function loop() {
  for (const serverId of SERVERS) {
    if (shuttingDown) {
      break;
    }

    try {
      await monitorServer(serverId);

    } catch (err) {
      console.error(
        `[${serverId}] ❌ Monitor error:`,
        err.message
      );
    }
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
        healthy ? 200 : 500,
        {
          "Content-Type": "text/plain"
        }
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
   * Clear watchdog state.
   */
  watchdogStates.clear();

  /*
   * Close the healthcheck server.
   */
  if (httpServer) {
    httpServer.close(() => {
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

console.log(
  `📡 Monitoring ${SERVERS.length} server(s)`
);

/*
 * Self-scheduling watchdog loop.
 *
 * The next iteration does not start until the
 * previous iteration has completely finished.
 */
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

    const elapsed =
      (Date.now() - start) / 1000;

    const delay =
      Math.max(
        0,
        CHECK_INTERVAL - elapsed
      );

    if (
      delay > 0 &&
      !shuttingDown
    ) {
      await sleep(delay);
    }
  }
}

startLoop();