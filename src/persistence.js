"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeRoom } = require("./room");

/**
 * Rooms are saved to a JSON file so a server restart does not end the game.
 * Sockets are gone after a restart, but every player keeps a secret token in
 * their browser, so they simply reconnect to their seat.
 */

function saveRooms(rooms, file) {
  // Functions (like room.notify) are skipped by JSON.stringify automatically.
  const json = JSON.stringify([...rooms.values()]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file); // atomic: a crash never leaves a half-written file
}

function loadRooms(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // no file yet, or unreadable: start fresh
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(r => r && typeof r.code === "string" && Array.isArray(r.players) && r.players.length)
    .map(normalizeRoom);
}

/** Debounced saving: many changes in a row cause a single write. */
function createAutosave(rooms, file, { delayMs = 1000 } = {}) {
  let timer = null;

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      saveRooms(rooms, file);
    } catch (e) {
      console.error("Could not save rooms:", e.message);
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  };

  return { schedule, flush };
}

module.exports = { saveRooms, loadRooms, createAutosave };
