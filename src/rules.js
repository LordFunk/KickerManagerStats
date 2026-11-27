"use strict";

/* Pure rule helpers: they read a room and answer questions, they never change it
 * (except the two hand helpers at the bottom, which only move cards between hands). */

const { CARD_DEFS, DRAW_AMOUNTS } = require("./cards");

const current = (room) => room.players[room.turn];
const topCard = (room) => room.discard[room.discard.length - 1] || null;

/** Players still in the round (No Mercy knocks players out). */
const activePlayers = (room) => room.players.filter(p => !p.eliminated);

/** Move `steps` seats in the direction of play, skipping players who are out. */
function nextIndex(room, from, steps = 1) {
  const n = room.players.length;
  let i = from;
  for (let s = 0; s < steps; s++) {
    let tries = 0;
    do { i = (i + room.direction + n) % n; tries += 1; } while (room.players[i].eliminated && tries <= n);
  }
  return i;
}

function cardLabel(card) {
  return CARD_DEFS[card.value]?.label ?? card.value;
}

/** Can this card be added on top of a pending draw penalty? */
function canStack(card, room) {
  if (!room.settings.stacking) return false;
  if (room.settings.noMercy) {
    // Any draw card at least as big as the last one.
    return (DRAW_AMOUNTS[card.value] ?? 0) >= (DRAW_AMOUNTS[room.drawPendingType] ?? Infinity);
  }
  if (card.value === "draw2") return room.drawPendingType === "draw2";
  if (card.value === "wild4") return room.settings.stackWild4;
  return false;
}

function canPlay(card, room) {
  const top = topCard(room);
  if (!top) return true;
  if (room.roulette) return false; // waiting for a colour choice
  if (room.drawPending > 0) return canStack(card, room);
  if (card.value === "skip" && top.value === "skip" && !room.settings.stackSkips) return false;
  return card.color === "wild" || card.color === room.activeColor || card.value === top.value;
}

/** Jump-in: an identical card (same colour and value) may be played out of turn. */
function canJumpIn(card, room) {
  const top = topCard(room);
  return room.settings.jumpIn && room.status === "playing" && room.drawPending === 0 && !room.roulette && !!top &&
    card.color !== "wild" && card.color === top.color && card.value === top.value;
}

function requireTurn(room, player) {
  if (room.status !== "playing" || current(room).id !== player.id) throw new Error("It is not your turn.");
}

function pickSwapTarget(room, player, targetId) {
  const others = activePlayers(room).filter(p => p.id !== player.id);
  if (others.length === 1) return others[0];
  const target = others.find(p => p.id === targetId);
  if (!target) throw new Error("Choose a player to swap hands with.");
  return target;
}

function swapHands(a, b) {
  [a.hand, b.hand] = [b.hand, a.hand];
}

/** Everyone passes their hand to the next player in the direction of play. */
function rotateHands(room) {
  const moves = room.players.map((p, i) => ({ to: p.eliminated ? null : room.players[nextIndex(room, i)], hand: p.hand }));
  moves.forEach(m => { if (m.to) m.to.hand = m.hand; });
}

module.exports = {
  current, topCard, activePlayers, nextIndex, DRAW_AMOUNTS, cardLabel, canStack, canPlay, canJumpIn,
  requireTurn, pickSwapTarget, swapHands, rotateHands
};
