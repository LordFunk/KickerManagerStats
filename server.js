"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const { createSocketLayer } = require("./src/sockets");
const { sanitizeSettings } = require("./src/settings");
const { CARD_DEFS } = require("./src/cards");
const { EMOTES } = require("./src/chat");
const persistence = require("./src/persistence");
const { createStats } = require("./src/stats");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

const app = express();
app.disable?.("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));
// The browser reads the same card table and reaction list the server uses.
const SHARED_JS = `window.CARD_DEFS = ${JSON.stringify(CARD_DEFS)};\nwindow.EMOTES = ${JSON.stringify(EMOTES)};`;
app.get("/shared.js", (_req, res) => res.type("application/javascript").send(SHARED_JS));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10_000 }); // game messages are tiny

const rooms = new Map();
// Saved to disk only when run directly; `UNO_STATS=off` switches the leaderboard off.
const stats = createStats(require.main === module ? path.join(DATA_DIR, "stats.json") : null, { enabled: process.env.UNO_STATS !== "off" });
app.get("/stats", (_req, res) => res.json({ players: stats.top(10) }));
const hooks = { onChange: () => {} };
const layer = createSocketLayer({
  io, rooms,
  onChange: (room) => hooks.onChange(room),
  stats,
  limits: process.env.UNO_RATE_LIMIT === "off" ? null : undefined // "off" is for automated tests only
});

// Only when run directly (not when the tests import this file): load saved rooms and start listening.
if (require.main === module) {
  const autosave = persistence.createAutosave(rooms, DATA_FILE);
  hooks.onChange = autosave.schedule;

  for (const room of persistence.loadRooms(DATA_FILE)) {
    rooms.set(room.code, room);
    layer.adoptRoom(room);
  }
  if (rooms.size) console.log(`Restored ${rooms.size} room(s) from ${DATA_FILE}`);

  const shutdown = () => { autosave.flush(); stats.flush(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(PORT, () => console.log(`Friend UNO listening on ${PORT}`));
}

module.exports = { app, server, io, rooms, layer, stats, sanitizeSettings };
