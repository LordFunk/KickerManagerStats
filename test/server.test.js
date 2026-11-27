"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ok, fails, lastState, card, lobby, startedGame, arrange, named, handIds } = require("./support");

/* ---------------------------------------------------------------- */
/* Rounds and the score table                                       */
/* ---------------------------------------------------------------- */
test("multiple rounds add up in the score table and the starter rotates", () => {
  const { room, socks } = startedGame(["A", "B", "C"]);
  assert.equal(room.round, 1);

  arrange(room, {
    hands: { A: [card("red", 5)], B: [card("blue", 7), card("wild", "wild")], C: [card("green", "skip"), card("yellow", 0)] },
    top: card("red", 3)
  });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });

  assert.equal(room.status, "finished");
  assert.equal(room.roundPoints, 77); // B: 7 + 50, C: 20 + 0
  assert.equal(room.gameWinner, null);

  fails(socks.B, "nextRound", {}, /host/);
  ok(socks.A, "nextRound");
  assert.equal(room.round, 2);
  assert.equal(room.status, "playing");
  assert.equal(room.turn, 1); // B starts round two
  assert.ok(room.players.every(p => p.hand.length === 7));

  arrange(room, {
    hands: { A: [card("red", 9)], B: [card("blue", 1)], C: [card("wild", "wild4")] },
    top: card("blue", 4), turn: 1
  });
  ok(socks.B, "playCard", { cardId: room.players[1].hand[0].id });
  assert.equal(room.roundPoints, 59);

  assert.deepEqual(room.scores.map(r => [r.name, r.total, r.rounds]), [
    ["A", 77, [77, 0]], ["B", 59, [0, 59]], ["C", 0, [0, 0]]
  ]);
});

test("the state sent to players carries the scoreboard and the round reveal", () => {
  const { room, socks } = startedGame(["A", "B"]);
  arrange(room, { hands: { A: [card("red", 5)], B: [card("blue", 8), card("blue", "skip")] }, top: card("red", 1) });
  assert.equal(lastState(socks.B).reveal, null); // nothing is revealed during play

  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });
  const state = lastState(socks.B);
  assert.equal(state.status, "finished");
  assert.equal(state.roundPoints, 28);
  assert.equal(state.round, 1);
  assert.equal(state.winnerLabel, "A");

  const a = state.scores.find(s => s.name === "A");
  assert.deepEqual(a, { id: a.id, name: "A", members: [a.id], total: 28, rounds: [28] });
  assert.equal(state.settings.targetScore, 500);

  // Everyone sees what was left in every hand, with its point value.
  assert.deepEqual(state.reveal.map(r => [r.name, r.hand.length, r.points]), [["A", 0, 0], ["B", 2, 28]]);
});

test("reaching the target score ends the game; newGame resets everything", () => {
  const { room, socks } = startedGame(["A", "B"], { targetScore: 100 });
  room.scores[0].total = 90;
  arrange(room, { hands: { A: [card("red", 5)], B: [card("blue", "skip"), card("blue", 5)] }, top: card("red", 1) });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });

  assert.equal(room.roundPoints, 25);
  assert.equal(room.gameWinner, "A");
  fails(socks.A, "nextRound", {}, /game is over/);

  ok(socks.A, "newGame");
  assert.equal(room.round, 1);
  assert.deepEqual(room.scores.map(r => [r.total, r.rounds]), [[0, []], [0, []]]);
  assert.equal(room.gameWinner, null);
  assert.deepEqual(room.log.length, 1); // the log starts over with the new game
});

test("going out with +2 or +4 makes the next player draw before points are counted", () => {
  const { room, socks } = startedGame(["A", "B", "C"]);
  arrange(room, {
    hands: { A: [card("red", "draw2")], B: [card("blue", 3)], C: [card("green", 4)] },
    top: card("red", 5)
  });
  room.deck.push(card("red", 9), card("red", 9));
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });
  assert.equal(room.roundPoints, 3 + 9 + 9 + 4);
});

test("startGame cannot be used to restart a running game", () => {
  const { socks } = startedGame(["A", "B"]);
  fails(socks.A, "startGame", {}, /already started/);
});

/* ---------------------------------------------------------------- */
/* Scoring modes                                                    */
/* ---------------------------------------------------------------- */
test("penalty mode: everyone collects their own leftover points and the lowest total wins", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { scoringMode: "penalty", targetScore: 100 });
  room.scores.find(r => r.name === "B").total = 90;
  arrange(room, {
    hands: { A: [card("red", 5)], B: [card("blue", 7), card("blue", "skip")], C: [card("green", 4)] },
    top: card("red", 1)
  });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });

  assert.deepEqual(room.scores.map(r => [r.name, r.total]), [["A", 0], ["B", 117], ["C", 4]]);
  assert.equal(room.gameWinner, "A"); // B passed the target, A has the lowest total
  assert.match(room.message, /lowest total/);
  assert.deepEqual(room.roundGains, Object.fromEntries(room.scores.map(r => [r.id, r.rounds[0]])));
});

test("team mode needs an even number of players, and teams share one score", () => {
  const three = lobby(["A", "B", "C"], { teams: true });
  fails(three.socks.A, "startGame", {}, /even number/);

  const { room, socks } = startedGame(["A", "B", "C", "D"], { teams: true });
  assert.deepEqual(room.scores.map(r => r.name), ["A & C", "B & D"]);
  assert.deepEqual(lastState(socks.A).players.map(p => p.team), [0, 1, 0, 1]);
});

test("team mode: the winning player's team scores the other team's cards", () => {
  const { room, socks } = startedGame(["A", "B", "C", "D"], { teams: true });
  arrange(room, {
    hands: {
      A: [card("red", 1), card("red", 2)], B: [card("blue", 5)], C: [card("red", 7)],
      D: [card("wild", "wild4")]
    },
    top: card("red", 3), turn: 2
  });
  ok(socks.C, "playCard", { cardId: named(room, "C").hand[0].id });

  assert.equal(room.roundPoints, 55); // B 5 + D 50; A's own leftover cards do not count
  assert.equal(room.winnerLabel, "A & C");
  assert.deepEqual(room.scores.map(r => r.total), [55, 0]);
  assert.match(room.message, /A & C win the round and score 55/);
});

/* ---------------------------------------------------------------- */
/* Game log                                                         */
/* ---------------------------------------------------------------- */
test("every action is added to the game log, newest last", () => {
  const { room, socks } = startedGame(["A", "B"], { drawOne: true });
  arrange(room, { hands: { A: [card("blue", 9), card("blue", 8)], B: [card("blue", 1), card("blue", 2)] }, top: card("red", 5) });
  room.deck.push(card("green", 1));

  ok(socks.A, "drawCard");
  ok(socks.B, "drawCard");
  const log = lastState(socks.A).log;
  assert.match(log[0], /Game started/);
  assert.match(log.at(-2), /A drew a card/);
  assert.match(log.at(-1), /B drew a card/);
});

test("the log is capped", () => {
  const { room, socks } = startedGame(["A", "B"]);
  for (let i = 0; i < 100; i++) {
    arrange(room, { hands: { A: [card("blue", 9), card("blue", 8)], B: [card("blue", 1)] }, top: card("red", 5) });
    room.deck.push(card("green", 1));
    ok(socks.A, "drawCard");
  }
  assert.equal(room.log.length, 60);
  assert.equal(lastState(socks.A).log.length, 30);
});

/* ---------------------------------------------------------------- */
/* Core rules                                                       */
/* ---------------------------------------------------------------- */
test("you cannot pass without drawing", () => {
  const { room, socks } = startedGame(["A", "B"], { drawOne: false });
  arrange(room, { hands: { A: [card("blue", 9), card("blue", 8)], B: [card("blue", 1), card("blue", 2)] }, top: card("red", 5) });
  fails(socks.A, "passTurn", {}, /Draw a card/);
  room.deck.push(card("green", 1));
  ok(socks.A, "drawCard");
  assert.equal(room.turn, 0); // drawOne is off, so the turn stays
  ok(socks.A, "passTurn");
  assert.equal(room.turn, 1);
});

test("stacking: +2 on +2 works, +4 on a penalty needs its own setting", () => {
  const { room, socks } = startedGame(["A", "B", "C"]);
  arrange(room, {
    hands: {
      A: [card("red", "draw2"), card("red", 1)],
      B: [card("wild", "wild4"), card("blue", "draw2")],
      C: [card("green", "draw2"), card("green", 1)]
    }
  });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });
  assert.equal(room.drawPending, 2);
  fails(socks.B, "playCard", { cardId: room.players[1].hand[0].id, color: "red" }, /cannot be played/);
  ok(socks.B, "playCard", { cardId: room.players[1].hand[1].id });
  assert.equal(room.drawPending, 4);

  room.settings.stackWild4 = true;
  arrange(room, {
    hands: { A: [card("wild", "wild4"), card("red", 1)], B: [card("red", 2)], C: [card("red", 3)] }
  });
  room.drawPending = 2; room.drawPendingType = "draw2";
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });
  assert.equal(room.drawPending, 6);
});

/* ---------------------------------------------------------------- */
/* Extra rules                                                      */
/* ---------------------------------------------------------------- */
test("jump-in: identical card out of turn when enabled", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { jumpIn: true });
  const arrangeJump = () => arrange(room, {
    hands: {
      A: [card("green", 1), card("green", 2)],
      B: [card("red", 5), card("blue", 5), card("red", 7)],
      C: [card("yellow", 1), card("yellow", 2)]
    },
    top: card("red", 5)
  });

  arrangeJump();
  const [identical, sameNumberOnly, sameColourOnly] = room.players[1].hand; // red 5, blue 5, red 7
  fails(socks.B, "playCard", { cardId: sameNumberOnly.id }, /not your turn/);
  fails(socks.B, "playCard", { cardId: sameColourOnly.id }, /not your turn/);
  ok(socks.B, "playCard", { cardId: identical.id });
  assert.match(room.message, /jumped in/);
  assert.equal(room.turn, 2); // play continues after the jumper

  room.settings.jumpIn = false;
  arrangeJump();
  fails(socks.B, "playCard", { cardId: room.players[1].hand[0].id }, /not your turn/);
});

test("7-0: a 7 swaps with the chosen player, a 0 rotates every hand", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { sevenZero: true });
  const setup = (direction = 1) => arrange(room, {
    hands: {
      A: [card("red", 7), card("red", 1)],
      B: [card("blue", 1)],
      C: [card("green", 1), card("green", 2)]
    },
    top: card("red", 3), direction
  });

  setup();
  const aSeven = room.players[0].hand[0].id;
  const cBefore = handIds(room, "C");
  fails(socks.A, "playCard", { cardId: aSeven }, /Choose a player/);
  assert.equal(room.players[0].hand.length, 2); // nothing happened
  ok(socks.A, "playCard", { cardId: aSeven, targetId: named(room, "C").id });
  assert.deepEqual(handIds(room, "A"), cBefore);
  assert.equal(room.players[2].hand.length, 1);

  const rotate = (direction) => {
    setup(direction);
    const [a, b, c] = ["A", "B", "C"].map(n => handIds(room, n));
    room.players[0].hand[0].value = "0"; // the red 7 becomes a red 0
    ok(socks.A, "playCard", { cardId: a[0] });
    return { a: a.slice(1), b, c, after: ["A", "B", "C"].map(n => handIds(room, n)) };
  };

  let r = rotate(1); // hands move to the next player in play order
  assert.deepEqual(r.after, [r.c, r.a, r.b]);
  r = rotate(-1);
  assert.deepEqual(r.after, [r.b, r.c, r.a]);
});

test("7-0 with two players picks the opponent automatically", () => {
  const { room, socks } = startedGame(["A", "B"], { sevenZero: true });
  arrange(room, { hands: { A: [card("red", 7), card("red", 1)], B: [card("blue", 1), card("blue", 2), card("blue", 3)] }, top: card("red", 3) });
  const bBefore = handIds(room, "B");
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id });
  assert.deepEqual(handIds(room, "A"), bBefore);
  assert.equal(room.players[1].hand.length, 1);
});

test("forced play: a playable drawn card must be played", () => {
  const { room, socks } = startedGame(["A", "B"], { forcedPlay: true });
  arrange(room, { hands: { A: [card("blue", 9), card("blue", 5)], B: [card("blue", 1)] }, top: card("red", 5) });
  const drawn = card("red", 8);
  room.deck.push(drawn);

  ok(socks.A, "drawCard");
  assert.equal(room.turn, 0); // the turn did not pass
  assert.equal(room.players[0].forcedCardId, drawn.id);
  assert.equal(lastState(socks.A).me.forcedCardId, drawn.id);
  fails(socks.A, "drawCard", {}, /must play/);
  fails(socks.A, "passTurn", {}, /must play/);
  fails(socks.A, "playCard", { cardId: room.players[0].hand[1].id }, /must play/);
  ok(socks.A, "playCard", { cardId: drawn.id });
  assert.equal(room.turn, 1);
  assert.equal(room.players[0].forcedCardId, null);

  // An unplayable draw just ends the turn (draw-one mode).
  arrange(room, { hands: { A: [card("blue", 9), card("blue", 8)], B: [card("blue", 1), card("blue", 2)] }, top: card("red", 5), turn: 1 });
  room.deck.push(card("green", 1));
  ok(socks.B, "drawCard");
  assert.equal(room.turn, 0);
});

test("challenge +4: an illegal +4 makes the player draw 4", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { challengeWild4: true });
  arrange(room, { hands: { A: [card("wild", "wild4"), card("red", 3), card("blue", 2)], B: [card("blue", 1)], C: [card("blue", 2)] }, top: card("red", 5) });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });

  assert.equal(room.drawPending, 4);
  assert.ok(room.challenge);
  fails(socks.C, "challengeWild4", {}, /nothing to challenge/);
  // The client is never told whether the +4 was legal.
  assert.deepEqual(Object.keys(lastState(socks.B).challenge).sort(), ["offenderName", "targetId"]);

  ok(socks.B, "challengeWild4");
  assert.equal(room.players[0].hand.length, 2 + 4);
  assert.equal(room.drawPending, 0);
  assert.equal(room.challenge, null);
  assert.equal(room.turn, 1); // B keeps the turn and plays normally
});

test("challenge +4: a legal +4 makes the challenger draw 6", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { challengeWild4: true });
  arrange(room, { hands: { A: [card("wild", "wild4"), card("blue", 2)], B: [card("blue", 1)], C: [card("blue", 2)] }, top: card("red", 5) });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });
  ok(socks.B, "challengeWild4");
  assert.equal(room.players[1].hand.length, 1 + 6);
  assert.equal(room.turn, 2); // B misses the turn
  assert.equal(room.drawPending, 0);
});

test("challenge +4: accepting (drawing) works with stacking on and off", () => {
  for (const stacking of [true, false]) {
    const { room, socks } = startedGame(["A", "B", "C"], { challengeWild4: true, stacking });
    arrange(room, { hands: { A: [card("wild", "wild4"), card("red", 3)], B: [card("blue", 1), card("blue", 4)], C: [card("blue", 2)] }, top: card("red", 5) });
    ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });
    if (!stacking) fails(socks.B, "playCard", { cardId: room.players[1].hand[0].id }, /cannot be played/);
    ok(socks.B, "drawCard");
    assert.equal(room.players[1].hand.length, 2 + 4);
    assert.equal(room.turn, 2);
    assert.equal(room.challenge, null);
    fails(socks.C, "challengeWild4", {}, /nothing to challenge/);
  }
});

test("without the challenge rule a +4 is applied immediately", () => {
  const { room, socks } = startedGame(["A", "B", "C"], { stacking: false });
  arrange(room, { hands: { A: [card("wild", "wild4"), card("red", 3)], B: [card("blue", 1)], C: [card("blue", 2)] } });
  ok(socks.A, "playCard", { cardId: room.players[0].hand[0].id, color: "blue" });
  assert.equal(room.players[1].hand.length, 5);
  assert.equal(room.turn, 2);
  assert.equal(room.challenge, null);
});

test("20 players can be dealt in (needs more than one deck)", () => {
  const names = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);
  const { room } = startedGame(names);
  assert.ok(room.players.every(p => p.hand.length === 7));
  assert.equal(room.deck.length + room.discard.length + 140, 216);
  assert.ok(room.discard[0]);
});
