"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const scoring = require("../src/scoring.js");
const { sanitizeSettings, sanitizeTurnSeconds } = require("../src/settings.js");
const { createBucket } = require("../src/rateLimit.js");

const card = (color, value) => ({ id: `${color}${value}`, color, value: String(value) });
const people = (...ids) => ids.map(id => ({ id, name: id.toUpperCase() }));

test("card and hand points follow the official UNO values", () => {
  assert.equal(scoring.cardPoints(card("red", 0)), 0);
  assert.equal(scoring.cardPoints(card("red", 9)), 9);
  for (const v of ["skip", "reverse", "draw2"]) assert.equal(scoring.cardPoints(card("red", v)), 20);
  for (const v of ["wild", "wild4"]) assert.equal(scoring.cardPoints(card("wild", v)), 50);
  assert.equal(scoring.handPoints([card("red", 7), card("blue", "skip"), card("wild", "wild4")]), 77);
  assert.equal(scoring.handPoints([]), 0);
});

test("winner mode: the winner scores the opponents' points, every round is recorded", () => {
  const board = scoring.createScoreboard(people("a", "b", "c"));
  const { points, gains } = scoring.scoreRound(board, "a", {
    a: [], b: [card("red", 7), card("red", "skip")], c: [card("wild", "wild")]
  });
  assert.equal(points, 77);
  assert.deepEqual(gains, { a: 77, b: 0, c: 0 });

  scoring.scoreRound(board, "b", { a: [card("red", 3)], b: [], c: [card("red", 1)] });
  assert.deepEqual(board.map(r => [r.total, r.rounds]), [[77, [77, 0]], [4, [0, 4]], [0, [0, 0]]]);
});

test("penalty mode: everyone but the winner scores their own leftover cards", () => {
  const board = scoring.createScoreboard(people("a", "b", "c"));
  const { points, gains } = scoring.scoreRound(board, "a", {
    a: [], b: [card("red", 7), card("red", "skip")], c: [card("wild", "wild")]
  }, { mode: "penalty" });
  assert.equal(points, 77);
  assert.deepEqual(gains, { a: 0, b: 27, c: 50 });
  assert.deepEqual(board.map(r => r.total), [0, 27, 50]);
});

test("team mode: seats alternate between two teams that share one score", () => {
  const players = people("a", "b", "c", "d");
  const board = scoring.createScoreboard(players, { teams: true });
  assert.deepEqual(board.map(r => [r.id, r.name, r.members]), [
    ["team0", "A & C", ["a", "c"]],
    ["team1", "B & D", ["b", "d"]]
  ]);

  // C goes out: team A scores what both opponents hold, A's own leftover card does not count.
  const hands = { a: [card("red", 9)], b: [card("blue", 5)], c: [], d: [card("wild", "wild4")] };
  const { points } = scoring.scoreRound(board, "c", hands);
  assert.equal(points, 55);
  assert.deepEqual(board.map(r => r.total), [55, 0]);

  // Penalty mode: the other team collects its own cards, the winning team collects nothing.
  scoring.scoreRound(board, "b", hands, { mode: "penalty" });
  assert.deepEqual(board.map(r => r.rounds), [[55, 9 + 0], [0, 0]]);
});

test("getGameWinner: highest wins in winner mode, lowest wins in penalty mode", () => {
  const row = (id, total) => ({ id, name: id, members: [id], total, rounds: [] });
  assert.equal(scoring.getGameWinner([], 500), null);

  const board = [row("a", 499), row("b", 10)];
  assert.equal(scoring.getGameWinner(board, 500), null);
  board[0].total = 500;
  assert.equal(scoring.getGameWinner(board, 500).name, "a");

  const penalty = [row("a", 520), row("b", 130), row("c", 300)];
  assert.equal(scoring.getGameWinner(penalty, 500, "penalty").name, "b");
  assert.equal(scoring.getGameWinner([row("a", 499), row("b", 3)], 500, "penalty"), null);
});

test("target score and turn timer settings are clamped", () => {
  assert.equal(scoring.sanitizeTargetScore("abc"), 500);
  assert.equal(scoring.sanitizeTargetScore(5), 100);
  assert.equal(scoring.sanitizeTargetScore(99999), 2000);
  assert.equal(scoring.sanitizeTargetScore("250"), 250);

  assert.equal(sanitizeTurnSeconds(undefined), 0);
  assert.equal(sanitizeTurnSeconds("0"), 0);
  assert.equal(sanitizeTurnSeconds(-5), 0);
  assert.equal(sanitizeTurnSeconds(3), 10);
  assert.equal(sanitizeTurnSeconds(45), 45);
  assert.equal(sanitizeTurnSeconds(9999), 180);
});

test("sanitizeSettings applies defaults and ignores junk", () => {
  assert.deepEqual(sanitizeSettings(null), {
    noMercy: false, stacking: true, stackWild4: false, stackSkips: true, mustCallUno: true, drawOne: true,
    jumpIn: false, sevenZero: false, forcedPlay: false, challengeWild4: false,
    turnSeconds: 0, teams: false, scoringMode: "winner", targetScore: 500
  });

  const s = sanitizeSettings({
    jumpIn: "yes", sevenZero: true, stacking: false, targetScore: 99999, turnSeconds: "30",
    teams: true, scoringMode: "penalty", evil: 1
  });
  assert.equal(s.jumpIn, false);
  assert.equal(s.sevenZero, true);
  assert.equal(s.stacking, false);
  assert.equal(s.targetScore, 2000);
  assert.equal(s.turnSeconds, 30);
  assert.equal(s.teams, true);
  assert.equal(s.scoringMode, "penalty");
  assert.equal("evil" in s, false);
  assert.equal(sanitizeSettings({ scoringMode: "nonsense" }).scoringMode, "winner");
});

test("rate limiter allows a burst, then refills over time", () => {
  let now = 0;
  const bucket = createBucket({ perSecond: 2, burst: 3, now: () => now });

  assert.deepEqual([1, 2, 3, 4].map(() => bucket.take()), [true, true, true, false]);
  now += 500; // one token back
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now += 60_000; // refills, but never above the burst size
  assert.deepEqual([1, 2, 3, 4].map(() => bucket.take()), [true, true, true, false]);
});
