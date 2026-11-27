"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ok, fails, card, startedGame, arrange, named, handIds, lastState, layer } = require("./support");
const { makeNoMercyDeck } = require("../src/deck");
const { sanitizeSettings } = require("../src/settings");
const scoring = require("../src/scoring");
const game = require("../src/game");

const NM = { noMercy: true };
const filler = (n, color = "blue", value = "9") => Array.from({ length: n }, () => card(color, value));

function table(names = ["A", "B", "C"], settings = NM) {
  const g = startedGame(names, settings);
  g.room.roulette = null;
  g.room.players.forEach(p => { p.eliminated = false; });
  return g;
}

test("No Mercy forces its own rules and keeps the rest", () => {
  const s = sanitizeSettings({ noMercy: true, stacking: false, drawOne: true, teams: true, scoringMode: "penalty", jumpIn: true, turnSeconds: 30 });
  assert.equal(s.noMercy, true);
  assert.deepEqual([s.stacking, s.sevenZero, s.drawOne, s.teams, s.scoringMode], [true, true, false, false, "winner"]);
  assert.equal(s.jumpIn, true);
  assert.equal(s.turnSeconds, 30);
  assert.equal(sanitizeSettings({}).noMercy, false);
});

test("the No Mercy deck has 168 cards with the new cards in it", () => {
  const deck = makeNoMercyDeck(1);
  assert.equal(deck.length, 168);
  assert.equal(new Set(deck.map(c => c.id)).size, 168);
  const count = (value) => deck.filter(c => c.value === value).length;
  assert.deepEqual(["draw6", "draw10", "revdraw4", "roulette"].map(count), [4, 4, 6, 6]);
  assert.equal(deck.filter(c => c.color === "wild").length, 20);
  assert.equal(count("wild"), 0, "there is no plain Wild");
  assert.equal(count("skipall"), 12);
});

test("points for the new cards", () => {
  assert.equal(scoring.cardPoints(card("red", "skipall")), 20);
  assert.equal(scoring.cardPoints(card("red", "discardall")), 20);
  assert.equal(scoring.cardPoints(card("red", "draw4")), 20);
  assert.equal(scoring.cardPoints(card("wild", "draw10")), 50);
  assert.equal(scoring.cardPoints(card("wild", "roulette")), 50);
});

test("draw cards stack onto equal or bigger ones, in any colour", () => {
  const { room, socks } = table();
  arrange(room, {
    top: card("red", "5"),
    hands: {
      A: [card("red", "draw2"), card("blue", "1")],
      B: [card("green", "draw4"), card("green", "draw2"), card("blue", "1")],
      C: [card("wild", "draw6"), card("wild", "draw10"), card("blue", "1")]
    }
  });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  assert.equal(room.drawPending, 2);

  ok(socks.B, "playCard", { cardId: named(room, "B").hand[1].id }); // an equal +2 can be stacked
  ok(socks.C, "playCard", { cardId: named(room, "C").hand[1].id, color: "red" }); // and +10 on top
  assert.equal(room.drawPending, 14);
});

test("a smaller draw card cannot answer a bigger one", () => {
  const { room, socks } = table();
  arrange(room, {
    top: card("red", "5"),
    hands: {
      A: [card("red", "draw4"), card("blue", "1")],
      B: [card("green", "draw2"), card("green", "draw4"), card("blue", "1")],
      C: [card("wild", "draw6"), card("blue", "1")]
    }
  });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  fails(socks.B, "playCard", { cardId: named(room, "B").hand[0].id }, /cannot be played/);
  ok(socks.B, "playCard", { cardId: named(room, "B").hand[1].id });      // +4 on +4
  ok(socks.C, "playCard", { cardId: named(room, "C").hand[0].id, color: "red" }); // +6 on +4
  assert.equal(room.drawPending, 14);
  assert.equal(room.drawPendingType, "draw6");

  // A takes everything.
  const before = named(room, "A").hand.length;
  ok(socks.A, "drawCard");
  assert.equal(named(room, "A").hand.length, before + 14);
  assert.equal(room.drawPending, 0);
});

test("with nothing to play you draw until a card fits, and must play it", () => {
  const { room, socks } = table();
    arrange(room, { top: card("red", "5"), hands: { A: [card("blue", "1")], B: filler(2), C: filler(2) } });
  room.deck = [card("red", "6"), card("blue", "2"), card("blue", "3")];

  ok(socks.A, "drawCard");
  const a = named(room, "A");
  assert.equal(a.hand.length, 4); // two misses and the playable red 6
  assert.equal(a.forcedCardId, a.hand.at(-1).id);
  fails(socks.A, "passTurn", {}, /must play/);
  ok(socks.A, "playCard", { cardId: a.forcedCardId });
});

test("Skip Everyone gives the same player another turn", () => {
  const { room, socks } = table();
  arrange(room, { top: card("red", "5"), hands: { A: [card("red", "skipall"), card("red", "1")], B: filler(3), C: filler(3) } });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  assert.equal(room.turn, 0);
  assert.equal(room.status, "playing");
});

test("Reverse +4 flips direction and hits the player behind you", () => {
  const { room, socks } = table(["A", "B", "C", "D"]);
  arrange(room, {
    top: card("red", "5"), turn: 1,
    hands: { A: filler(3), B: [card("wild", "revdraw4"), card("red", "1")], C: filler(3), D: filler(3) }
  });
  ok(socks.B, "playCard", { cardId: named(room, "B").hand[0].id, color: "green" });
  assert.equal(room.direction, -1);
  assert.equal(room.turn, 0, "the penalty goes back to A");
  assert.equal(room.drawPending, 4);
  assert.equal(room.activeColor, "green");
});

test("two players: Reverse +4 sends the penalty back to the player who played it", () => {
  const { room, socks } = table(["A", "B"]);
  arrange(room, { top: card("red", "5"), hands: { A: [card("wild", "revdraw4"), card("red", "1")], B: filler(3) } });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id, color: "red" });
  assert.equal(room.turn, 0);
  assert.equal(room.drawPending, 4);
});

test("Discard All dumps your cards of that colour, and can win the round", () => {
  const { room, socks } = table();
  const dump = card("red", "discardall");
  arrange(room, {
    top: card("red", "5"),
    hands: { A: [dump, card("red", "1"), card("red", "2"), card("blue", "3")], B: filler(3), C: filler(3) }
  });
  ok(socks.A, "playCard", { cardId: dump.id });
  assert.deepEqual(named(room, "A").hand.map(c => c.color), ["blue"]);
  assert.equal(room.discard.at(-1).id, dump.id, "the played card stays on top");
  assert.equal(room.discard.length, 4, "top card, then the dumped cards underneath");

  arrange(room, { top: card("red", "5"), hands: { A: [card("red", "discardall"), card("red", "1"), card("red", "2")], B: filler(3), C: filler(3) } });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  assert.equal(room.status, "finished");
  assert.equal(room.winner, "A");
});

test("Colour Roulette: the next player names a colour and draws until it appears", () => {
  const { room, socks } = table();
  arrange(room, { top: card("red", "5"), hands: { A: [card("wild", "roulette"), card("red", "1")], B: filler(2), C: filler(2) } });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id, color: "red" });

  assert.equal(room.turn, 1);
  assert.ok(room.roulette);
  assert.equal(lastState(socks.B).mustChooseColor, true);
  assert.equal(lastState(socks.B).canPlay, false);
  assert.equal(lastState(socks.C).mustChooseColor, false);

  fails(socks.B, "drawCard", {}, /colour/);
  fails(socks.B, "playCard", { cardId: named(room, "B").hand[0].id }, /colour/);
  fails(socks.C, "chooseColor", { color: "green" }, /no colour/);
  fails(socks.B, "chooseColor", { color: "purple" }, /Choose a colour/);

  room.deck = [card("green", "4"), card("blue", "1"), card("yellow", "1"), card("blue", "2")]; // pop order: blue 2, yellow 1, ...
  ok(socks.B, "chooseColor", { color: "green" });
  assert.equal(named(room, "B").hand.length, 2 + 4);
  assert.equal(room.activeColor, "green");
  assert.equal(room.roulette, null);
  assert.equal(room.turn, 2, "B misses their turn");
});

test("an away player's Colour Roulette is answered automatically", () => {
  const { room, socks } = table();
  arrange(room, { top: card("red", "5"), hands: { A: [card("wild", "roulette"), card("red", "1")], B: [card("green", "1"), card("green", "2")], C: filler(2) } });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id, color: "red" });
  room.deck = [card("green", "7")];
  game.autoPlay(room);
  layer.commit(room);
  assert.equal(room.roulette, null);
  assert.equal(room.turn, 2);
  assert.match(room.message, /ran out of time/);
});

test("reaching 25 cards knocks a player out; the last one standing wins with the mercy bonus", () => {
  const { room, socks } = table();
  arrange(room, {
    top: card("red", "5"),
    hands: { A: [card("red", "draw4"), card("red", "1")], B: filler(23), C: filler(4) }
  });
  room.scores.forEach(r => { r.total = 0; r.rounds = []; });
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  ok(socks.B, "drawCard"); // 23 + 4 = 27
  assert.equal(named(room, "B").eliminated, true);
  assert.equal(named(room, "B").hand.length, 0);
  assert.equal(room.setAside.length, 27);
  assert.equal(room.turn, 2, "play moves on to C");
  assert.equal(room.status, "playing");
  assert.match(room.message, /is out!/);

  // B is skipped from now on.
  arrange(room, { top: card("red", "5"), turn: 2, hands: { C: [card("red", "9"), card("red", "8")], A: [card("blue", "1"), card("blue", "2")] } });
  room.players[1].eliminated = true;
  ok(socks.C, "playCard", { cardId: named(room, "C").hand[0].id });
  assert.equal(room.turn, 0, "B is skipped");
  assert.equal(lastState(socks.A).players.find(p => p.name === "B").eliminated, true);

  // Knock C out too: A wins, scoring the bonus for each knocked-out player.
  named(room, "C").hand = filler(24);
  named(room, "A").hand = [card("red", "draw2"), card("blue", "5")];
  arrange(room, { top: card("red", "5"), turn: 0, hands: {} });
  room.players[1].eliminated = true;
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  ok(socks.C, "drawCard"); // takes 2, reaches 26
  assert.equal(room.status, "finished");
  assert.equal(room.winner, "A");
  assert.equal(room.roundPoints, 500);
  assert.equal(room.scores.find(r => r.id === named(room, "A").id).total, 500);
  const reveal = lastState(socks.A).reveal;
  assert.deepEqual(reveal.filter(r => r.eliminated).map(r => [r.name, r.points]), [["B", 250], ["C", 250]]);
});

test("never knocks everyone out at once", () => {
  const { room } = table(["A", "B"]);
  room.players[0].hand = filler(26);
  room.players[1].hand = filler(25);
  room.message = "";
  game.enforceMercy(room);
  assert.equal(room.status, "finished");
  assert.equal(room.winner, "B", "the player with the fewest cards survives");
  assert.equal(room.players[0].eliminated, true);
});

test("7 and 0 skip players who are out", () => {
  const { room, socks } = table(["A", "B", "C", "D"]);
  arrange(room, {
    top: card("red", "5"),
    hands: { A: [card("red", "0"), card("blue", "1")], B: [card("green", "1")], C: [card("green", "2"), card("green", "3")], D: [card("green", "4")] }
  });
  named(room, "B").eliminated = true;
  named(room, "B").hand = [];
  ok(socks.A, "playCard", { cardId: named(room, "A").hand[0].id });
  // hands pass along: A -> C -> D -> A ; B untouched and still out
  assert.equal(named(room, "C").hand.length, 1);
  assert.equal(named(room, "D").hand.length, 2);
  assert.equal(named(room, "A").hand.length, 1);
  assert.equal(named(room, "B").hand.length, 0);
  assert.equal(room.turn, 2, "B is skipped");
});

test("a classic game is unaffected", () => {
  const { room } = startedGame(["A", "B", "C"], {});
  assert.equal(room.deck.length + room.discard.length + room.players.reduce((n, p) => n + p.hand.length, 0), 108);
  assert.equal(room.settings.noMercy, false);
});
