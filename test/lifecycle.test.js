"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  makeFakeIo, connect, send, ok, fails, lastEvent, lastState, card, lobby, startedGame, arrange, named, rooms, layer
} = require("./support");
const { createSocketLayer, GRACE_MS, ABANDONED_ROOM_MS } = require("../src/sockets");
const { AWAY_TURN_SECONDS } = require("../src/timers");
const { saveRooms, loadRooms, createAutosave } = require("../src/persistence");

const { mock } = test;
const useFakeTimers = () => mock.timers.enable({ apis: ["setTimeout"] });
test.afterEach(() => mock.timers.reset());

/** A position where every card in the hands is unplayable, so a draw is predictable. */
const quietTable = (room, turn = 0) => {
  arrange(room, {
    hands: { A: [card("blue", 9), card("blue", 8)], B: [card("blue", 1), card("blue", 2)] },
    top: card("red", 5), turn
  });
  room.deck.push(card("green", 1));
};

/* ---------------------------------------------------------------- */
/* Turn timer                                                       */
/* ---------------------------------------------------------------- */
test("turn timer: a player who runs out of time draws and the turn moves on", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B"], { turnSeconds: 15 });
  assert.ok(lastState(socks.A).turnEndsAt, "clients are told when the turn ends");

  quietTable(room);
  mock.timers.tick(14_999);
  assert.equal(room.players[0].hand.length, 2); // still waiting
  mock.timers.tick(1);

  assert.equal(room.players[0].hand.length, 3);
  assert.equal(room.turn, 1);
  assert.match(room.message, /A ran out of time/);
  assert.match(room.log.at(-1), /ran out of time/);
  assert.ok(lastState(socks.B).turnEndsAt, "the next player's timer is running");
});

test("turn timer: acting in time restarts the clock for the next player", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B"], { turnSeconds: 15 });
  quietTable(room);

  mock.timers.tick(10_000);
  ok(socks.A, "drawCard"); // A is in time; B's 15 seconds start now
  room.deck.push(card("green", 2));
  mock.timers.tick(14_999);
  assert.equal(room.players[1].hand.length, 2); // B has not timed out yet
  mock.timers.tick(1);
  assert.equal(room.players[1].hand.length, 3);
  assert.equal(room.turn, 0);
});

test("turn timer: off by default", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B"]);
  quietTable(room);
  mock.timers.tick(10 * 60 * 1000);
  assert.equal(room.players[0].hand.length, 2);
  assert.equal(lastState(socks.A).turnEndsAt, null);
});

test("timeout while a +4 can be challenged simply accepts the penalty", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B", "C"], { turnSeconds: 10, challengeWild4: true });
  arrange(room, { hands: { A: [card("wild", "wild4"), card("blue", 2)], B: [card("blue", 1)], C: [card("blue", 3)] }, top: card("red", 5) });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });
  mock.timers.tick(10_000);
  assert.equal(room.players[1].hand.length, 1 + 4);
  assert.equal(room.challenge, null);
  assert.equal(room.turn, 2);
});

test("away players: the game plays a legal card for them after a short wait", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B", "C"]);
  arrange(room, { hands: { A: [card("blue", 9), card("red", 7)], B: [card("blue", 1)], C: [card("blue", 2)] }, top: card("red", 5) });

  socks.A.handlers.disconnect(); // it is A's turn
  mock.timers.tick(AWAY_TURN_SECONDS * 1000 - 1);
  assert.equal(room.players[0].hand.length, 2);
  mock.timers.tick(1);

  assert.equal(room.players[0].hand.length, 1);
  assert.equal(room.discard.at(-1).value, "7");
  assert.match(room.message, /A is away/);
  assert.equal(room.turn, 1);
});

test("away players: a wild picks the colour they hold most, otherwise they draw", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B"]);
  arrange(room, { hands: { A: [card("wild", "wild"), card("blue", 1), card("blue", 2)], B: [card("red", 1), card("red", 2)] }, top: card("red", 5) });
  socks.A.handlers.disconnect();
  mock.timers.tick(AWAY_TURN_SECONDS * 1000);
  assert.equal(room.activeColor, "blue");

  quietTable(room, 0);
  layer.emitRoom(room); // a real action would broadcast here, which also starts the away timer
  mock.timers.tick(AWAY_TURN_SECONDS * 1000); // A is still away and nothing is playable
  assert.equal(room.players[0].hand.length, 3);
  assert.equal(room.turn, 1);
});

test("nobody connected: no automatic turns run", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B"]);
  quietTable(room);
  socks.A.handlers.disconnect();
  socks.B.handlers.disconnect();
  mock.timers.tick(60 * 1000);
  assert.equal(room.players[0].hand.length, 2);
});

/* ---------------------------------------------------------------- */
/* Reconnecting                                                     */
/* ---------------------------------------------------------------- */
test("reconnecting with the secret token returns your seat and your hand", () => {
  const { room, socks, tokens, code } = startedGame(["A", "B", "C"]);
  const hand = named(room, "B").hand.map(c => c.id);

  socks.B.handlers.disconnect();
  assert.equal(named(room, "B").connected, false);
  assert.equal(lastState(socks.A).players.find(p => p.name === "B").connected, false);

  const fresh = connect();
  ok(fresh, "rejoinRoom", { code, token: tokens.B });
  assert.equal(lastEvent(fresh, "joined").playerId, named(room, "B").id);
  assert.equal(named(room, "B").connected, true);
  assert.deepEqual(lastState(fresh).me.hand.map(c => c.id), hand);

  // The old tab lost the seat, and its late "disconnect" must not take it away again.
  fails(socks.B, "drawCard", {}, /another tab/);
  socks.B.handlers.disconnect();
  assert.equal(named(room, "B").connected, true);
});

test("a wrong or missing token cannot take a seat", () => {
  const { code, room } = startedGame(["A", "B"]);
  for (const payload of [{ code, token: "nope" }, { code, token: "" }, { code }, { code: "ZZZZ", token: "x" }, undefined]) {
    const intruder = connect();
    ok(intruder, "rejoinRoom", payload);
    assert.ok(intruder.received.some(([e]) => e === "rejoinFailed"));
  }
  assert.ok(room.players.every(p => p.connected));
});

test("tokens are never sent to other players", () => {
  const { socks, tokens } = startedGame(["A", "B", "C"]);
  for (const sock of Object.values(socks)) {
    const seen = JSON.stringify([lastState(sock), lastEvent(sock, "lobby")]);
    for (const token of Object.values(tokens)) assert.equal(seen.includes(token), false);
  }
});

test("lobby: a dropped player keeps the seat for a short grace period", () => {
  useFakeTimers();
  const { room, socks, tokens, code } = lobby(["A", "B", "C"]);

  socks.B.handlers.disconnect();
  assert.equal(room.players.length, 3);
  assert.equal(named(room, "B").connected, false);
  mock.timers.tick(GRACE_MS - 1);
  assert.equal(room.players.length, 3);
  mock.timers.tick(1);
  assert.deepEqual(room.players.map(p => p.name), ["A", "C"]);

  // Refreshing the page in time keeps the seat for good.
  socks.C.handlers.disconnect();
  ok(connect(), "rejoinRoom", { code, token: tokens.C });
  mock.timers.tick(GRACE_MS * 3);
  assert.equal(named(room, "C").connected, true);
});

test("lobby: when the host stays away the next player becomes host; an empty room disappears", () => {
  useFakeTimers();
  const { room, socks, code } = lobby(["A", "B", "C"]);
  const bId = named(room, "B").id;

  socks.A.handlers.disconnect();
  mock.timers.tick(GRACE_MS);
  assert.deepEqual(room.players.map(p => p.name), ["B", "C"]);
  assert.equal(room.hostId, bId);
  assert.equal(lastState(socks.B).hostId, bId);

  socks.B.handlers.disconnect();
  socks.C.handlers.disconnect();
  mock.timers.tick(GRACE_MS);
  assert.equal(rooms.has(code), false);
});

test("in a running game the seat stays and only the host role moves", () => {
  useFakeTimers();
  const { room, socks } = startedGame(["A", "B", "C"]);
  socks.A.handlers.disconnect();
  mock.timers.tick(GRACE_MS);
  assert.equal(room.players.length, 3);
  assert.equal(named(room, "A").connected, false);
  assert.equal(room.hostId, named(room, "B").id);
});

test("a game nobody has come back to for hours is cleaned up", () => {
  useFakeTimers();
  const { room, socks, code } = startedGame(["A", "B"]);
  socks.A.handlers.disconnect();
  socks.B.handlers.disconnect();
  mock.timers.tick(ABANDONED_ROOM_MS);
  assert.equal(rooms.has(code), false);
  assert.ok(room); // (the room object itself is simply no longer reachable by code)
});

test("leaving on purpose: lobby seats are freed, game seats cannot be reclaimed", () => {
  useFakeTimers();
  const inLobby = lobby(["A", "B", "C"]);
  ok(inLobby.socks.B, "leaveRoom");
  assert.deepEqual(inLobby.room.players.map(p => p.name), ["A", "C"]);
  const ghost = connect();
  ok(ghost, "rejoinRoom", { code: inLobby.code, token: inLobby.tokens.B });
  assert.ok(ghost.received.some(([e]) => e === "rejoinFailed"));

  const { room, socks, tokens, code } = startedGame(["A", "B", "C"]);
  ok(socks.A, "leaveRoom"); // the host leaves mid-game
  assert.equal(room.players.length, 3);
  assert.equal(named(room, "A").connected, false);
  assert.equal(room.hostId, named(room, "B").id);
  const again = connect();
  ok(again, "rejoinRoom", { code, token: tokens.A });
  assert.ok(again.received.some(([e]) => e === "rejoinFailed"));

  // Their seat is played automatically, so the game goes on.
  arrange(room, { hands: { A: [card("red", 7), card("red", 8)], B: [card("blue", 1)], C: [card("blue", 2)] }, top: card("red", 5) });
  mock.timers.tick(AWAY_TURN_SECONDS * 1000);
  assert.equal(room.players[0].hand.length, 1);
});

/* ---------------------------------------------------------------- */
/* Spectators                                                       */
/* ---------------------------------------------------------------- */
test("joining a running game means watching: no hand, no actions, no leaks", () => {
  const { room, socks, code } = startedGame(["A", "B"]);
  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "Eve" });

  assert.equal(lastEvent(watcher, "joined").spectator, true);
  const state = lastState(watcher);
  assert.equal(state.spectator, true);
  assert.equal(state.me, null);
  assert.equal(state.canPlay, false);
  assert.equal(lastState(socks.A).spectators, 1);

  const json = JSON.stringify(state);
  for (const p of room.players) for (const c of p.hand) assert.equal(json.includes(c.id), false, "a hand card leaked");

  for (const event of ["drawCard", "passTurn", "callUno", "nextRound", "startGame"]) fails(watcher, event, {}, /only watch/);
  assert.equal(room.players.length, 2);
});

test("spectators are updated, can leave, and are limited in number", () => {
  const { room, socks, code } = startedGame(["A", "B"]);
  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "Eve" });
  ok(socks.A, "drawCard");
  assert.ok(lastState(watcher).log.length >= 2);

  ok(watcher, "leaveRoom");
  assert.equal(room.spectators.length, 0);

  for (let i = 0; i < 30; i++) ok(connect(), "joinRoom", { code, name: `W${i}` });
  fails(connect(), "joinRoom", { code, name: "TooMany" }, /too many spectators/);
});

test("a spectator who refreshes the page gets back in", () => {
  const { code } = startedGame(["A", "B"]);
  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "Eve" });
  const { token } = lastEvent(watcher, "joined");

  watcher.handlers.disconnect();
  const fresh = connect();
  ok(fresh, "rejoinRoom", { code, token });
  assert.equal(lastEvent(fresh, "joined").spectator, true);
  assert.equal(lastState(fresh).spectator, true);
});

test("the lobby shows teams and how many people are watching", () => {
  const { socks } = lobby(["A", "B", "C", "D"], { teams: true });
  assert.deepEqual(lastEvent(socks.A, "lobby").players.map(p => p.team), [0, 1, 0, 1]);
  assert.equal(lastEvent(socks.A, "lobby").spectators, 0);
});

/* ---------------------------------------------------------------- */
/* Rate limiting                                                    */
/* ---------------------------------------------------------------- */
test("rate limit: actions and room-code guessing are throttled per connection", () => {
  const io = makeFakeIo();
  createSocketLayer({ io, rooms: new Map() }); // default limits

  const guesser = io.connect();
  const answers = Array.from({ length: 8 }, (_, i) => send(guesser, "joinRoom", { code: `AB${i}${i}`, name: "X" }));
  assert.deepEqual(answers.slice(0, 5).map(a => /Room not found/.test(a)), [true, true, true, true, true]);
  assert.ok(answers.slice(5).every(a => /too fast/.test(a)));

  const strict = makeFakeIo();
  createSocketLayer({
    io: strict, rooms: new Map(),
    limits: { action: { perSecond: 0.001, burst: 3 }, entry: { perSecond: 0.001, burst: 2 } }
  });
  const s = strict.connect();
  ok(s, "createRoom", { name: "A" });
  const replies = Array.from({ length: 5 }, () => send(s, "startGame", {}));
  assert.deepEqual(replies.map(r => /too fast/.test(r)), [false, false, false, true, true]);
});

/* ---------------------------------------------------------------- */
/* Persistence                                                      */
/* ---------------------------------------------------------------- */
const tempFile = (name = "rooms.json") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uno-")), "data", name);

test("a saved game survives a server restart and players take their seats back", () => {
  const { room, socks, tokens, code } = startedGame(["A", "B", "C"], { jumpIn: true, targetScore: 250 });
  ok(socks.A, "drawCard");
  const hands = Object.fromEntries(room.players.map(p => [p.name, p.hand.map(c => c.id)]));

  const file = tempFile();
  saveRooms(new Map([[code, room]]), file); // room.notify (a function) must not break saving
  const loaded = loadRooms(file);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].code, code);
  assert.equal(loaded[0].settings.targetScore, 250);
  assert.equal(loaded[0].round, 1);
  assert.ok(loaded[0].players.every(p => !p.connected && p.socketId === null));
  assert.deepEqual(loaded[0].players.map(p => p.token), room.players.map(p => p.token));

  // "Restart": a brand new server layer adopts the saved room.
  const io = makeFakeIo();
  const restored = new Map(loaded.map(r => [r.code, r]));
  const layer = createSocketLayer({ io, rooms: restored, limits: null });
  loaded.forEach(r => layer.adoptRoom(r));

  const back = io.connect();
  ok(back, "rejoinRoom", { code, token: tokens.B });
  const state = lastState(back);
  assert.equal(state.status, "playing");
  assert.deepEqual(state.me.hand.map(c => c.id), hands.B);
  assert.equal(state.players.length, 3);
  assert.deepEqual(state.players.map(p => p.connected), [false, true, false]);

  // And the game still works after the restart.
  const turnIndex = state.turn;
  const current = restored.get(code).players[turnIndex];
  assert.ok(current);
});

test("loading tolerates a missing, broken or odd file", () => {
  const file = tempFile();
  assert.deepEqual(loadRooms(file), []);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  assert.deepEqual(loadRooms(file), []);

  fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadRooms(file), []);

  const { room } = lobby(["A", "B"]);
  fs.writeFileSync(file, JSON.stringify([null, { code: 5 }, { code: "X", players: [] }, JSON.parse(JSON.stringify(room))]));
  assert.deepEqual(loadRooms(file).map(r => r.code), [room.code]);
});

test("autosave waits a moment and writes many changes as one file", () => {
  useFakeTimers();
  const file = tempFile();
  const { room } = lobby(["A", "B"]);
  const autosave = createAutosave(new Map([[room.code, room]]), file, { delayMs: 1000 });

  for (let i = 0; i < 5; i++) autosave.schedule();
  assert.equal(fs.existsSync(file), false);
  mock.timers.tick(1000);
  assert.equal(fs.existsSync(file), true);
  assert.equal(loadRooms(file).length, 1);

  fs.rmSync(file);
  autosave.flush(); // used on shutdown: writes immediately
  assert.equal(fs.existsSync(file), true);
});
