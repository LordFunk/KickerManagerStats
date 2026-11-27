"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ok, card, startedGame, arrange, lastState, connect, named } = require("./support");
const { CARD_DEFS, DRAW_AMOUNTS } = require("../src/cards");
const { makeDeck, makeNoMercyDeck } = require("../src/deck");
const scoring = require("../src/scoring");

const ids = (...cards) => cards.map(c => c.id);

test("the server tells each player which cards they can play", () => {
  const { room, socks } = startedGame(["A", "B", "C"], {});
  const red3 = card("red", "3"), green4 = card("green", "4"), wild = card("wild", "wild"), green5 = card("green", "5");
  arrange(room, { top: card("red", "5"), hands: { A: [red3, green4, wild], B: [green5, card("blue", "1")], C: [card("blue", "2")] } });
  ok(socks.A, "drawCard"); // any action makes the server send fresh state
  arrange(room, { top: card("red", "5"), hands: { A: [red3, green4, wild], B: [green5, card("blue", "1")], C: [card("blue", "2")] } });
  require("./support").layer.emitRoom(room);

  assert.deepEqual(lastState(socks.A).me.playable, ids(red3, wild));
  assert.deepEqual(lastState(socks.B).me.playable, [], "not your turn, and jump-in is off");
});

test("jump-in cards are playable out of turn, and a pending draw limits the choice", () => {
  const { room, socks } = startedGame(["A", "B"], { jumpIn: true });
  const twin = card("red", "5"), other = card("red", "6");
  arrange(room, { top: card("red", "5"), hands: { A: [card("blue", "1")], B: [twin, other] } });
  require("./support").layer.emitRoom(room);
  assert.deepEqual(lastState(socks.B).me.playable, ids(twin));

  const plus2 = card("red", "draw2"), plus4 = card("wild", "wild4");
  arrange(room, { top: card("red", "draw2"), hands: { A: [plus2, plus4, card("red", "1")], B: [card("blue", "1")] } });
  room.drawPending = 2;
  room.drawPendingType = "draw2";
  require("./support").layer.emitRoom(room);
  assert.deepEqual(lastState(socks.A).me.playable, ids(plus2), "+4 may not be stacked unless the rule is on");
});

test("a card you must play is the only playable one; spectators and eliminated players get nothing", () => {
  const { room, socks, code } = startedGame(["A", "B"], {});
  const a = named(room, "A");
  const keep = card("red", "9"), other = card("red", "8");
  arrange(room, { top: card("red", "5"), hands: { A: [keep, other], B: [card("blue", "1")] } });
  a.forcedCardId = keep.id;
  require("./support").layer.emitRoom(room);
  assert.deepEqual(lastState(socks.A).me.playable, ids(keep));

  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "W" });
  assert.equal(lastState(watcher).me, null);
});

test("every special card in either deck is in the shared card table", () => {
  for (const deck of [makeDeck(1), makeNoMercyDeck(1)]) {
    for (const c of deck) {
      if (/^[0-9]$/.test(c.value)) continue;
      assert.ok(CARD_DEFS[c.value], `${c.value} is missing from src/cards.js`);
    }
  }
  assert.equal(Object.keys(DRAW_AMOUNTS).length, 6);
  assert.equal(scoring.cardPoints({ color: "wild", value: "draw10" }), 50);
  assert.equal(scoring.cardPoints({ color: "red", value: "7" }), 7);
});
