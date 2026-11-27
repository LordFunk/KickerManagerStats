"use strict";

const { CARD_DEFS } = require("./cards");

/**
 * Official UNO scoring.
 *
 *  - Number cards (0-9) ........ face value
 *  - Skip / Reverse / Draw Two .. 20 points
 *  - Wild / Wild Draw Four ..... 50 points
 *
 * Two modes:
 *  - "winner"  (official): the round winner scores the cards left in the
 *              opponents' hands. First to reach the target wins.
 *  - "penalty": everyone except the winner scores the cards left in their
 *              own hand. When someone reaches the target the game ends and the
 *              LOWEST total wins.
 *
 * Scoreboard rows are players, or teams when team mode is on. Each row lists
 * its `members` (player ids), so the same code handles both.
 *
 * Pure functions only: no sockets, no globals, easy to test.
 */

const DEFAULT_TARGET_SCORE = 500;
const MIN_TARGET_SCORE = 100;
const MAX_TARGET_SCORE = 2000;

const MERCY_BONUS = 250; // No Mercy: scored for each opponent knocked out, instead of their hand

function cardPoints(card) {
  if (card.value in CARD_DEFS) return CARD_DEFS[card.value].points;
  const n = Number(card.value);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : 0;
}

function handPoints(hand) {
  return hand.reduce((sum, card) => sum + cardPoints(card), 0);
}

/** Teams are the even and odd seats, so seating alternates around the table. */
const seatTeam = (seatIndex) => seatIndex % 2;

/** Create an empty scoreboard from the players in the room. */
function createScoreboard(players, { teams = false } = {}) {
  if (!teams) {
    return players.map(p => ({ id: p.id, name: p.name, members: [p.id], total: 0, rounds: [] }));
  }
  const sides = [[], []];
  players.forEach((p, i) => sides[seatTeam(i)].push(p));
  return sides.map((members, i) => ({
    id: `team${i}`,
    name: members.map(m => m.name).join(" & "),
    members: members.map(m => m.id),
    total: 0,
    rounds: []
  }));
}

/**
 * Score a finished round and record it on the scoreboard (mutates it).
 *
 * @param scoreboard  array from createScoreboard()
 * @param winnerId    id of the player who went out
 * @param hands       { [playerId]: card[] } hands at the end of the round
 * @param options.mode "winner" or "penalty"
 * @param options.eliminated ids of players knocked out by the mercy rule (worth `mercyBonus` each)
 * @returns { points, gains }  `points` is the total value of the opposing
 *          hands, `gains` maps each scoreboard row id to what it scored.
 */
function scoreRound(scoreboard, winnerId, hands, { mode = "winner", eliminated = [], mercyBonus = MERCY_BONUS } = {}) {
  const rowOf = (playerId) => scoreboard.find(r => r.members.includes(playerId));
  const winnerRow = rowOf(winnerId);
  const gains = Object.fromEntries(scoreboard.map(r => [r.id, 0]));
  let points = 0;

  for (const [playerId, hand] of Object.entries(hands)) {
    const row = rowOf(playerId);
    if (!row || row === winnerRow) continue; // the winner's own side never scores against itself
    const value = eliminated.includes(playerId) ? mercyBonus : handPoints(hand);
    points += value;
    gains[mode === "penalty" ? row.id : winnerRow.id] += value;
  }

  for (const row of scoreboard) {
    row.rounds.push(gains[row.id]);
    row.total += gains[row.id];
  }

  return { points, gains };
}

/** The row that has won the game, or null if the game is still going. */
function getGameWinner(scoreboard, targetScore = DEFAULT_TARGET_SCORE, mode = "winner") {
  if (!scoreboard.length) return null;

  if (mode === "penalty") {
    if (!scoreboard.some(r => r.total >= targetScore)) return null;
    return [...scoreboard].sort((a, b) => a.total - b.total)[0];
  }

  const top = [...scoreboard].sort((a, b) => b.total - a.total)[0];
  return top.total >= targetScore ? top : null;
}

/** Clamp a user supplied target score into the allowed range. */
function sanitizeTargetScore(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_TARGET_SCORE;
  return Math.min(MAX_TARGET_SCORE, Math.max(MIN_TARGET_SCORE, n));
}

module.exports = {
  DEFAULT_TARGET_SCORE, MIN_TARGET_SCORE, MAX_TARGET_SCORE, MERCY_BONUS,
  cardPoints, handPoints, seatTeam, createScoreboard, scoreRound, getGameWinner, sanitizeTargetScore
};
