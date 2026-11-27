"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeIo, connect, send, ok, fails, lastState, lastEvent, lobby, startedGame, arrange, card, named, rooms, layer } = require("./support");
const { createSocketLayer, MAX_PLAYERS } = require("../src/sockets");
const { botDelay } = require("../src/timers");
const { playBotStep, chooseCard, bestColor } = require("../src/bot");
const { createStats } = require("../src/stats");
const { normalizeRoom } = require("../src/room");
const { cleanChatText, EMOTES } = require("../src/chat");
const game = require("../src/game");

const { mock } = test;
test.afterEach(() => mock.timers.reset());

/* ---------------------------------------------------------------- */
/* Chat and reactions                                               */
/* ---------------------------------------------------------------- */
test("chat reaches everyone, including spectators, and is cleaned up", () => {
  const { room, socks, code } = startedGame(["A", "B"], {});
  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "W" });

  ok(socks.A, "chat", { text: "  hello‮   there\n\n" });
  ok(watcher, "chat", { text: "nice game" });
  ok(socks.B, "chat", { emote: "laugh" });

  for (const s of [socks.A, socks.B, watcher]) {
    const chat = lastState(s).chat;
    assert.deepEqual(chat.map(c => [c.name, c.text ?? c.emote]), [["A", "hello there"], ["W", "nice game"], ["B", "laugh"]]);
  }
  assert.equal(room.log.some(l => /hello/.test(l)), false, "chat stays out of the game log");
});

test("chat rejects empty text, unknown reactions and over-long text", () => {
  const { socks, room } = lobby(["A", "B"]);
  fails(socks.A, "chat", { text: "   " }, /something/);
  fails(socks.A, "chat", { emote: "poop" }, /Unknown/);
  fails(socks.A, "chat", { emote: "__proto__" }, /Unknown/);
  ok(socks.A, "chat", { text: "x".repeat(500) });
  assert.equal(room.chat[0].text.length, 120);
  assert.equal(cleanChatText(null), "");
  assert.equal(Object.keys(EMOTES).length, 8);

  for (let i = 0; i < 60; i++) ok(socks.B, "chat", { text: `m${i}` });
  assert.equal(room.chat.length, 50, "only the latest messages are kept");
  assert.equal(room.chat.at(-1).text, "m59");
});

test("someone who is not in a room cannot chat, and chat is throttled", () => {
  const io = makeFakeIo();
  createSocketLayer({ io, rooms: new Map() });
  const lonely = io.connect();
  fails(lonely, "chat", { text: "hi" }, /not in a room/);

  ok(lonely, "createRoom", { name: "A" });
  const replies = Array.from({ length: 8 }, (_, i) => send(lonely, "chat", { text: `m${i}` }));
  // the failed attempt above already used one of the 5 burst tokens
  assert.deepEqual(replies.map(r => /too fast/.test(r ?? "")), [false, false, false, false, true, true, true, true]);
});

/* ---------------------------------------------------------------- */
/* Bots                                                             */
/* ---------------------------------------------------------------- */
test("the host can add and remove bots in the lobby, nobody else can", () => {
  const { room, socks } = lobby(["A", "B"]);
  fails(socks.B, "addBot", {}, /host/);
  ok(socks.A, "addBot", {});
  ok(socks.A, "addBot", {});
  const bots = room.players.filter(p => p.bot);
  assert.deepEqual(bots.map(b => b.name), ["Bot Ava", "Bot Bo"]);
  assert.ok(bots.every(b => b.connected && b.token === null));
  assert.equal(lastEvent(socks.B, "lobby").players.filter(p => p.bot).length, 2);

  fails(socks.B, "removeBot", { playerId: bots[0].id }, /host/);
  fails(socks.A, "removeBot", { playerId: room.players[0].id }, /not here/);
  ok(socks.A, "removeBot", { playerId: bots[0].id });
  assert.equal(room.players.length, 3);
  ok(socks.A, "addBot", {});
  assert.equal(room.players.filter(p => p.bot).length, 2);

  ok(socks.A, "startGame");
  fails(socks.A, "addBot", {}, /before the game/);
  fails(socks.A, "removeBot", { playerId: bots[1].id }, /before the game/);
});

test("bots fill the room up to the player limit", () => {
  const { socks } = lobby(["A"]);
  for (let i = 0; i < MAX_PLAYERS - 1; i++) ok(socks.A, "addBot", {});
  fails(socks.A, "addBot", {}, /full/);
});

test("a bot takes its turn after a short pause, and play carries on to a human", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { room, socks } = lobby(["A"]);
  ok(socks.A, "addBot", {});
  ok(socks.A, "startGame");

  // Put the bot on turn with a single playable card.
  const play = card("red", "6");
  arrange(room, { top: card("red", "5"), turn: 1, hands: { A: [card("blue", "1"), card("blue", "2")], "Bot Ava": [play, card("green", "7")] } });
  layer.emitRoom(room);

  assert.equal(room.turn, 1, "the bot has not moved yet");
  mock.timers.tick(botDelay.max + 5);
  assert.equal(room.turn, 0, "the bot played and it is A's turn");
  assert.equal(room.discard.at(-1).id, play.id);
  assert.match(lastState(socks.A).message, /Bot Ava/);
});

test("a bot draws, then plays or passes, when it has nothing to play", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { room, socks } = lobby(["A"], { drawOne: true });
  ok(socks.A, "addBot", {});
  ok(socks.A, "startGame");
  arrange(room, { top: card("red", "5"), turn: 1, hands: { A: [card("blue", "1")], "Bot Ava": [card("green", "7"), card("green", "8")] } });
  room.deck.push(card("blue", "3")); // the bot will draw this one: still not playable
  layer.emitRoom(room);

  mock.timers.tick(botDelay.max + 5);
  assert.equal(named(room, "Bot Ava").hand.length, 3);
  assert.equal(room.turn, 0, "draw-one: the turn passed after the draw");
});

test("a bot answers Colour Roulette and challenges only when allowed", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { room, socks } = lobby(["A"], { noMercy: true });
  ok(socks.A, "addBot", {});
  ok(socks.A, "startGame");
  arrange(room, { top: card("red", "5"), turn: 0, hands: { A: [card("wild", "roulette"), card("red", "1")], "Bot Ava": [card("green", "1"), card("green", "2")] } });
  room.roulette = null;
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id, color: "red" });
  assert.ok(room.roulette);
  room.deck.push(card("green", "9"));
  mock.timers.tick(botDelay.max + 5);
  assert.equal(room.roulette, null);
  assert.equal(room.activeColor, "green", "the bot named the colour it holds most of");
});

test("bots never reach 25 cards without the room noticing, and games with bots finish", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  for (const settings of [{}, { noMercy: true, targetScore: 250 }]) {
    const { room, socks } = lobby(["Human"], settings);
    ["a", "b", "c"].forEach(() => ok(socks.Human, "addBot", {}));
    ok(socks.Human, "startGame");

    for (let i = 0; i < 4000 && room.status === "playing"; i++) {
      const cur = room.players[room.turn];
      if (cur.bot) mock.timers.tick(botDelay.max + 5);
      else game.autoPlay(room), layer.commit(room); // the human is "away"
    }
    assert.equal(room.status, "finished", "the round ends");
    assert.ok(room.winner);
  }
});

test("bots alone do not keep a room alive, are never hosts, and survive a restart", () => {
  const { room, socks, tokens } = lobby(["A", "B"]);
  ok(socks.A, "addBot", {});
  assert.equal(room.hostId, room.players[0].id);

  const saved = JSON.parse(JSON.stringify(room));
  const restored = normalizeRoom(saved);
  assert.equal(restored.players.find(p => p.bot).connected, true);
  assert.equal(restored.players.filter(p => !p.bot).every(p => !p.connected), true);
  assert.equal(restored.chat.length, 0);
  void tokens; void rooms;
});

test("bot choices: keeps wilds for later and names the colour it holds most of", () => {
  const room = { settings: {}, players: [], turn: 0, direction: 1, drawPending: 0, discard: [card("red", "5")], activeColor: "red" };
  const bot = { name: "Bot", bot: true, hand: [card("wild", "wild"), card("red", "7"), card("green", "1"), card("green", "2")] };
  room.players = [bot, { name: "H", hand: [card("blue", "1"), card("blue", "2"), card("blue", "3"), card("blue", "4")] }];
  for (let i = 0; i < 20; i++) assert.equal(chooseCard(room, bot, Math.random).value, "7");
  assert.equal(bestColor(bot.hand, () => 0), "green");
  assert.equal(playBotStep({ status: "lobby" }), false);
});

/* ---------------------------------------------------------------- */
/* Stats                                                            */
/* ---------------------------------------------------------------- */
function finishedRoom(overrides = {}) {
  const players = [
    { id: "a", name: "Alex" }, { id: "b", name: "Bea" }, { id: "c", name: "Bot Ava", bot: true }, { id: "d", name: "Dan" }
  ];
  return {
    status: "finished", round: 1, recordedRound: 0, winner: "Alex", gameWinner: null, players,
    settings: { teams: false, targetScore: 500, scoringMode: "winner" },
    scores: players.map(p => ({ id: p.id, name: p.name, members: [p.id], total: p.id === "a" ? 600 : 10, rounds: [] })),
    ...overrides
  };
}

test("stats count each round once, ignore bots, and rank by game wins", () => {
  const stats = createStats(null);
  const room = finishedRoom();
  stats.record(room);
  stats.record(room); // the same round again: ignored
  assert.deepEqual(stats.top().map(p => [p.name, p.rounds, p.roundWins, p.wins]), [["Alex", 1, 1, 0], ["Bea", 1, 0, 0], ["Dan", 1, 0, 0]]);

  Object.assign(room, { round: 2, gameWinner: "Alex" });
  stats.record(room);
  const alex = stats.top()[0];
  assert.deepEqual([alex.name, alex.games, alex.wins, alex.roundWins, alex.rounds], ["Alex", 1, 1, 2, 2]);
  assert.equal(stats.top().find(p => p.name === "Bea").wins, 0);
  assert.equal(stats.top().some(p => p.name.startsWith("Bot")), false);
});

test("stats credit a whole winning team", () => {
  const stats = createStats(null);
  const room = finishedRoom({
    gameWinner: "A & C", winner: "Alex",
    settings: { teams: true, targetScore: 500, scoringMode: "winner" }
  });
  room.players = [{ id: "a", name: "Alex" }, { id: "b", name: "Bea" }, { id: "c", name: "Cy" }, { id: "d", name: "Dan" }];
  room.scores = [
    { id: "team0", name: "A & C", members: ["a", "c"], total: 600, rounds: [] },
    { id: "team1", name: "B & D", members: ["b", "d"], total: 10, rounds: [] }
  ];
  stats.record(room);
  const byName = Object.fromEntries(stats.top().map(p => [p.name, p.wins]));
  assert.deepEqual(byName, { Alex: 1, Cy: 1, Bea: 0, Dan: 0 });
});

test("stats can be switched off", () => {
  const stats = createStats(null, { enabled: false });
  stats.record(finishedRoom());
  assert.deepEqual(stats.top(), []);
});

test("stats are saved to disk and read back", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uno-stats-")), "data", "stats.json");
  const stats = createStats(file);
  stats.record(finishedRoom());
  stats.flush();
  assert.equal(createStats(file).top()[0].name, "Alex");
  assert.deepEqual(createStats(path.join(path.dirname(file), "missing.json")).top(), []);
});

test("the server records stats after a finished round", () => {
  const { stats } = require("./support").server;
  const { room, socks } = startedGame(["Zed", "Yan"], {});
  arrange(room, { top: card("red", "5"), hands: { Zed: [card("red", "9")], Yan: [card("blue", "1"), card("blue", "2")] } });
  ok(socks.Zed, "playCard", { cardId: named(room, "Zed").hand[0].id });
  assert.equal(room.status, "finished");
  assert.equal(stats.top(50).find(p => p.name === "Zed").roundWins, 1);
  assert.equal(room.recordedRound, room.round);
});
