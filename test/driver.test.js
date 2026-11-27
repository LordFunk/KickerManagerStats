"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ok, lobby, lastState } = require("./support");
const { decide } = require("./driver");

const VARIANTS = [
  {},
  { stacking: true, stackWild4: true, jumpIn: true, sevenZero: true, forcedPlay: true, challengeWild4: true },
  { drawOne: false, mustCallUno: false },
  { noMercy: true, targetScore: 250 }
];

test("players who only use what the page receives can finish whole games", () => {
  let finished = 0;
  for (let game = 0; game < 40; game++) {
    const settings = VARIANTS[game % VARIANTS.length];
    const names = ["A", "B", "C", "D"].slice(0, 2 + (game % 3));
    const { room, socks } = lobby(names, settings);
    ok(socks[names[0]], "startGame");

    for (let step = 0; step < 6000 && room.status === "playing"; step++) {
      for (const name of names) {
        const action = decide(lastState(socks[name]));
        if (action) ok(socks[name], ...action); // any rejected move fails the test
        if (room.status !== "playing") break;
      }
    }
    if (room.status === "finished") finished++;
  }
  assert.ok(finished >= 38, `only ${finished}/40 games finished`);
});
