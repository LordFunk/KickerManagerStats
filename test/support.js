"use strict";

/*
 * Shared test helpers (this file contains no tests itself).
 *
 * express and socket.io are replaced by tiny in-memory fakes, so the suite runs
 * with plain `node --test` and needs no network, no installs and no open ports.
 */

process.env.UNO_RATE_LIMIT = "off"; // the rate limiter has its own tests

const Module = require("node:module");
const assert = require("node:assert/strict");

/* ---------------------------------------------------------------- */
/* Fake socket.io                                                   */
/* ---------------------------------------------------------------- */
let socketCounter = 0;

function makeFakeIo() {
  const sockets = new Map();
  const channels = new Map();

  const io = {
    connection: null,
    on(event, cb) { if (event === "connection") this.connection = cb; },
    to(target) {
      return {
        emit(event, payload) {
          const ids = sockets.has(target) ? [target] : [...(channels.get(target) || [])];
          ids.forEach(id => sockets.get(id)?.received.push([event, payload]));
        }
      };
    },
    /** A new browser connecting. */
    connect() {
      const id = `sock${++socketCounter}`;
      const sock = {
        id, data: {}, received: [], handlers: {},
        on(event, cb) { this.handlers[event] = cb; },
        emit(event, payload) { this.received.push([event, payload]); },
        join(code) { (channels.get(code) || channels.set(code, new Set()).get(code)).add(id); },
        leave(code) { channels.get(code)?.delete(id); }
      };
      sockets.set(id, sock);
      io.connection(sock);
      return sock;
    }
  };
  return io;
}

/* ---------------------------------------------------------------- */
/* Load the real server with fakes in place of its dependencies     */
/* ---------------------------------------------------------------- */
const mainIo = makeFakeIo();
const fakeExpress = Object.assign(
  () => Object.assign(() => {}, { use() {}, get() {}, disable() {} }),
  { static: () => () => {} }
);

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "express") return fakeExpress;
  if (request === "socket.io") return { Server: function Server() { return mainIo; } };
  return originalLoad.call(this, request, ...rest);
};
const server = require("../server.js");
Module._load = originalLoad;

const { rooms, layer, sanitizeSettings } = server;
const connect = () => mainIo.connect();

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */
// Errors that mean a bug in the server (rather than a normal "not allowed" answer).
const BUG = /Cannot (read|set)|is not a function|is not defined|is not iterable|undefined/;

/** Send an event; return the error message the server answered with, or null. */
function send(sock, event, payload) {
  sock.received.length = 0;
  sock.handlers[event](payload);
  const err = sock.received.find(([e]) => e === "errorMessage");
  if (err && BUG.test(err[1])) throw new Error(`Server bug surfaced as error: ${err[1]}`);
  return err ? err[1] : null;
}

const ok = (sock, event, payload) => assert.equal(send(sock, event, payload), null, `${event} should succeed`);

function fails(sock, event, payload, pattern) {
  const err = send(sock, event, payload);
  assert.ok(err, `${event} should fail`);
  if (pattern) assert.match(err, pattern);
}

const lastEvent = (sock, name) => sock.received.filter(([e]) => e === name).pop()?.[1];
const lastState = (sock) => lastEvent(sock, "state");

let cardCounter = 0;
const card = (color, value) => ({ id: `c${++cardCounter}`, color, value: String(value) });

/** Create a room with the given player names. The first player is the host. */
function lobby(names, settings = {}) {
  const socks = {};
  const tokens = {};
  const host = connect();
  ok(host, "createRoom", { name: names[0], settings });
  const hostJoined = lastEvent(host, "joined");
  const code = hostJoined.code;
  socks[names[0]] = host;
  tokens[names[0]] = hostJoined.token;

  for (const name of names.slice(1)) {
    const s = connect();
    ok(s, "joinRoom", { name, code });
    socks[name] = s;
    tokens[name] = lastEvent(s, "joined").token;
  }
  return { room: rooms.get(code), socks, tokens, code };
}

function startedGame(names, settings = {}) {
  const g = lobby(names, settings);
  ok(g.socks[names[0]], "startGame");
  return g;
}

/** Put the game into an exact, known position. */
function arrange(room, { hands = {}, top = card("red", 5), color = top.color, turn = 0, direction = 1 }) {
  for (const p of room.players) if (hands[p.name]) p.hand = hands[p.name];
  room.discard = [top];
  room.activeColor = color;
  room.turn = turn;
  room.turnSerial += 1;
  room.direction = direction;
  room.drawPending = 0;
  room.drawPendingType = null;
  room.challenge = null;
  room.hasDrawn = false;
  room.players.forEach(p => { p.forcedCardId = null; p.saidUno = false; p.unoGraceUntil = 0; });
}

const named = (room, name) => room.players.find(p => p.name === name);
const handIds = (room, name) => named(room, name).hand.map(c => c.id);

module.exports = {
  makeFakeIo, connect, send, ok, fails, lastEvent, lastState, card, lobby, startedGame, arrange, named, handIds,
  rooms, layer, sanitizeSettings, server
};
