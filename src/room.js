"use strict";

const crypto = require("crypto");
const { uid } = require("./deck");
const { sanitizeSettings } = require("./settings");

/** Secret that lets a browser reclaim its seat after a refresh or a lost connection. */
const newToken = () => crypto.randomBytes(16).toString("hex");

function cleanName(name) {
  const n = String(name || "").trim().slice(0, 18);
  if (!n) throw new Error("Enter a player name.");
  return n;
}

function newPlayer(socketId, name) {
  return {
    id: uid(), token: newToken(), socketId, name, hand: [], connected: true,
    saidUno: false, unoGraceUntil: 0, forcedCardId: null, eliminated: false
  };
}

/** A computer player: always connected, has no browser and no reconnect token. */
function newBot(name) {
  return { ...newPlayer(null, name), token: null, bot: true };
}

function newSpectator(socketId, name) {
  return { id: uid(), token: newToken(), socketId, name, connected: true };
}

function newRoom({ code, host, settings }) {
  return {
    code, hostId: host.id, players: [host], spectators: [], status: "lobby",
    settings: sanitizeSettings(settings),
    deck: [], discard: [], direction: 1, turn: 0, turnSerial: 0, turnEndsAt: null,
    activeColor: null, drawPending: 0, drawPendingType: null, hasDrawn: false, challenge: null,
    roulette: null, setAside: [], chat: [], recordedRound: 0,
    round: 0, scores: [], roundPoints: null, roundGains: null,
    gameWinner: null, winner: null, winnerLabel: null,
    message: "Waiting for friends to join.", log: []
  };
}

/** Fill in anything missing from a room loaded from an older snapshot. */
function normalizeRoom(raw) {
  const room = { ...newRoom({ code: raw.code, host: { id: raw.hostId }, settings: raw.settings }), ...raw };
  room.settings = sanitizeSettings(raw.settings);
  room.spectators = [];
  room.log = Array.isArray(raw.log) ? raw.log : [];
  room.chat = Array.isArray(raw.chat) ? raw.chat : [];
  room.players = (raw.players || []).map(p => ({
    ...newPlayer(null, p.name), ...p, connected: !!p.bot, socketId: null // bots never disconnect
  }));
  return room;
}

module.exports = { newToken, cleanName, newPlayer, newBot, newSpectator, newRoom, normalizeRoom };
