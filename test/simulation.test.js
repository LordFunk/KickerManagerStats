"use strict";

/*
 * Random games: bots play legal moves (and sometimes drop out, reconnect, time out or
 * spectate) under many rule combinations. After every step the number of cards must be
 * unchanged, and every finished round must score exactly as the scoring module says.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { connect, send, ok, startedGame, layer } = require("./support");
const scoring = require("../src/scoring");
const game = require("../src/game");

const COLORS = ["red", "yellow", "green", "blue"];
const FLAGS = ["noMercy", "stacking", "stackWild4", "stackSkips", "mustCallUno", "drawOne", "jumpIn", "sevenZero", "forcedPlay", "challengeWild4"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function simulate(names, settings) {
  const g = startedGame(names, settings);
  const { room, socks, tokens, code } = g;
  const total = room.settings.noMercy
    ? Math.ceil((names.length * 7 + 60) / 168) * 168
    : Math.ceil((names.length * 7 + 20) / 108) * 108;

  const watcher = connect();
  ok(watcher, "joinRoom", { code, name: "Watcher" });

  const conserved = () => {
    const count = room.deck.length + room.discard.length + room.setAside.length + room.players.reduce((s, p) => s + p.hand.length, 0);
    assert.equal(count, total, "card count changed");
  };

  /** A player closes the tab and opens it again: new socket, same seat. */
  const dropAndReturn = (player, whileAway = () => {}) => {
    socks[player.name].handlers.disconnect();
    whileAway();
    const fresh = connect();
    ok(fresh, "rejoinRoom", { code, token: tokens[player.name] });
    socks[player.name] = fresh;
  };

  const tryPlay = (player) => {
    const others = room.players.filter(p => p !== player && !p.eliminated);
    if (!others.length) return false;
    for (const c of [...player.hand].sort(() => Math.random() - 0.5)) {
      const error = send(socks[player.name], "playCard", { cardId: c.id, color: pick(COLORS), targetId: pick(others).id });
      if (error === null) return true;
    }
    return false;
  };

  for (let step = 0; step < 4000 && room.status === "playing"; step++) {
    conserved();
    const roll = Math.random();

    // The turn timer (or an away player) takes a turn for someone.
    if (roll < 0.04) {
      const player = room.players[room.turn];
      if (Math.random() < 0.5) dropAndReturn(player, () => { game.autoPlay(room); layer.commit(room); });
      else { game.autoPlay(room); layer.commit(room); }
      continue;
    }
    if (roll < 0.06) dropAndReturn(pick(room.players)); // someone refreshes their page
    if (settings.jumpIn && Math.random() < 0.3) tryPlay(pick(room.players.filter(p => p !== room.players[room.turn]))); // may legally fail
    send(watcher, "drawCard", {}); // spectators are ignored

    if (room.status !== "playing") break;
    const actor = room.players[room.turn];
    const sock = socks[actor.name];

    if (room.roulette && room.roulette.targetId === actor.id) { ok(sock, "chooseColor", { color: pick(COLORS) }); continue; }

    if (room.challenge && room.challenge.targetId === actor.id && Math.random() < 0.5) { ok(sock, "challengeWild4"); continue; }
    if (tryPlay(actor)) continue;
    if (room.hasDrawn && !room.drawPending) ok(sock, "passTurn");
    else ok(sock, "drawCard");
  }

  conserved();
  return { room, watcher };
}

test("random games finish with consistent scores under every rule combination", () => {
  let finished = 0;
  let played = 0;

  for (let mask = 0; mask < 96; mask++) {
    const settings = { targetScore: 100, scoringMode: mask % 3 === 0 ? "penalty" : "winner" };
    // a spread of rule combinations: the bits pick the rule set
    FLAGS.forEach((f, i) => { settings[f] = Boolean(((mask * 37 + i * 11) >> (i % 6)) & 1) ^ (i < 5 && mask % 2 === 0); });

    const count = 2 + (mask % 5); // 2..6 players
    settings.teams = count % 2 === 0 && count >= 4 && mask % 4 === 1;
    const names = ["A", "B", "C", "D", "E", "F"].slice(0, count);

    settings.noMercy = mask % 3 === 1; // a third of the games are No Mercy
    const { room, watcher } = simulate(names, settings);
    played++;

    // Spectators must never be able to see a hand during play.
    const view = JSON.stringify(watcherState(watcher));
    if (room.status === "playing") {
      for (const p of room.players) for (const c of p.hand) assert.equal(view.includes(c.id), false, "a hand leaked to a spectator");
    }

    if (room.status !== "finished") continue;
    finished++;

    const winner = room.players.find(p => p.name === room.winner);
    const survivors = room.players.filter(p => !p.eliminated);
    assert.ok(winner.hand.length === 0 || (survivors.length === 1 && survivors[0] === winner), "winner went out or was last standing");

    // Recompute the round from the final hands: the room's score table must match.
    const expected = scoring.createScoreboard(room.players, { teams: room.settings.teams });
    scoring.scoreRound(
      expected, winner.id, Object.fromEntries(room.players.map(p => [p.id, p.hand])),
      { mode: room.settings.scoringMode, eliminated: room.players.filter(p => p.eliminated).map(p => p.id) }
    );
    assert.deepEqual(room.scores.map(r => r.total), expected.map(r => r.total));
    assert.equal(room.scores.length, room.settings.teams ? 2 : names.length);
  }

  assert.ok(finished / played > 0.9, `only ${finished}/${played} games finished`);
});

function watcherState(sock) {
  return sock.received.filter(([e]) => e === "state").pop()?.[1] ?? {};
}
