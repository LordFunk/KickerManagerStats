"use strict";

const fs = require("fs");
const path = require("path");
const scoring = require("./scoring");

/**
 * All-time results per player name (there are no accounts, so a name is the identity:
 * fine for a group of friends). Bots never count. Pass a file to keep the numbers
 * between restarts, or null to keep them in memory only (tests).
 */
function createStats(file = null, { enabled = true, delayMs = 1000 } = {}) {
  let players = {};
  let timer = null;

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw.players === "object") players = raw.players;
    } catch { /* no file yet */ }
  }

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ players }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.error("Could not save stats:", e.message);
    }
  };
  const schedule = () => {
    if (!file || timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  };

  const entry = (name) => {
    const key = name.toLowerCase();
    return (players[key] ||= { name, games: 0, wins: 0, rounds: 0, roundWins: 0 });
  };

  /** Call after every action: counts a finished round (and a finished game) exactly once. */
  function record(room) {
    if (!enabled || room.status !== "finished" || room.recordedRound === room.round) return;
    room.recordedRound = room.round;

    const humans = room.players.filter(p => !p.bot);
    const winner = room.players.find(p => p.name === room.winner);
    const winningSeats = new Set();
    if (winner) {
      room.players.forEach((p, i) => {
        const together = room.settings.teams ? scoring.seatTeam(i) === scoring.seatTeam(room.players.indexOf(winner)) : p === winner;
        if (together) winningSeats.add(p.id);
      });
    }

    for (const p of humans) {
      const e = entry(p.name);
      e.name = p.name;
      e.rounds += 1;
      if (winningSeats.has(p.id)) e.roundWins += 1;
    }

    if (room.gameWinner) {
      const row = scoring.getGameWinner(room.scores, room.settings.targetScore, room.settings.scoringMode);
      const members = new Set(row?.members ?? []);
      for (const p of humans) {
        const e = entry(p.name);
        e.games += 1;
        if (members.has(p.id)) e.wins += 1;
      }
    }
    schedule();
  }

  /** Best first: most game wins, then round wins. */
  function top(limit = 10) {
    if (!enabled) return [];
    return Object.values(players)
      .filter(p => p.rounds > 0)
      .sort((a, b) => b.wins - a.wins || b.roundWins - a.roundWins || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  return { record, top, flush };
}

module.exports = { createStats };
