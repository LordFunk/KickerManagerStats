"use strict";

const { current } = require("./rules");
const { autoPlay } = require("./game");
const { playBotStep } = require("./bot");

/** How long an away (disconnected) player is waited for before the game plays for them. */
const AWAY_TURN_SECONDS = 8;

const turnTimers = new Map(); // room code -> { key, handle }

function clearTurnTimer(room) {
  const entry = turnTimers.get(room.code);
  if (entry) clearTimeout(entry.handle);
  turnTimers.delete(room.code);
  room.turnEndsAt = null;
}

/**
 * Make sure the right timer is running for the current turn. Safe to call
 * after every change: it only restarts when the turn (or the player's
 * connection) actually changed.
 *
 * @param onFire  called after the automatic turn was played, so it can be broadcast
 */
function armTurnTimer(room, onFire) {
  if (room.status !== "playing" || !room.players.some(p => p.connected && !p.bot)) {
    clearTurnTimer(room);
    return;
  }

  const player = current(room);
  let seconds = room.settings.turnSeconds;
  if (!player.connected) seconds = Math.min(seconds || AWAY_TURN_SECONDS, AWAY_TURN_SECONDS);
  if (!seconds) {
    clearTurnTimer(room);
    return;
  }

  const key = `${room.round}:${room.turnSerial}:${player.connected}`;
  const existing = turnTimers.get(room.code);
  if (existing?.key === key) return; // same turn: let it keep running

  clearTurnTimer(room);
  room.turnEndsAt = Date.now() + seconds * 1000;

  const handle = setTimeout(() => {
    turnTimers.delete(room.code);
    if (room.status !== "playing") return;
    autoPlay(room);
    onFire(room);
  }, seconds * 1000);
  handle.unref?.();
  turnTimers.set(room.code, { key, handle });
}

/* ---------------------------------------------------------------- */
/* Bots                                                             */
/* ---------------------------------------------------------------- */
const botTimers = new Map(); // room code -> { key, handle }
const botDelay = { min: 900, max: 1700 }; // how long a bot "thinks" (the tests shorten this)

function clearBotTimer(room) {
  const entry = botTimers.get(room.code);
  if (entry) clearTimeout(entry.handle);
  botTimers.delete(room.code);
}

/** When it is a bot's turn, let it act after a short pause. Safe to call after every change. */
function armBotTimer(room, onFire, rng = Math.random) {
  const player = room.status === "playing" ? current(room) : null;
  if (!player?.bot || player.eliminated || !room.players.some(p => p.connected && !p.bot)) {
    clearBotTimer(room);
    return;
  }

  // The key changes after every bot action (a draw changes the hand, a play changes the turn).
  const key = `${room.round}:${room.turnSerial}:${player.hand.length}:${room.hasDrawn}:${room.drawPending}:${room.roulette ? 1 : 0}`;
  if (botTimers.get(room.code)?.key === key) return;

  clearBotTimer(room);
  const wait = botDelay.min + rng() * (botDelay.max - botDelay.min);
  const handle = setTimeout(() => {
    botTimers.delete(room.code);
    if (playBotStep(room, rng)) onFire(room);
  }, wait);
  handle.unref?.();
  botTimers.set(room.code, { key, handle });
}

module.exports = { AWAY_TURN_SECONDS, armTurnTimer, clearTurnTimer, armBotTimer, clearBotTimer, botDelay };
