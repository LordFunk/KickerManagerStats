"use strict";

const crypto = require("crypto");

const COLORS = ["red", "yellow", "green", "blue"];
const ACTION_VALUES = ["skip", "reverse", "draw2"];
const DECK_SIZE = 108;
const NO_MERCY_DECK_SIZE = 168;
const NO_MERCY_COLOR_ACTIONS = ["skip", "reverse", "draw2", "draw4", "skipall", "discardall"];

const isNumberCard = (card) => /^[0-9]$/.test(card.value);

const uid = () => crypto.randomBytes(8).toString("hex");

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A standard 108-card deck. Big tables use several decks shuffled together. */
function makeDeck(copies = 1) {
  const deck = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const color of COLORS) {
      deck.push({ id: uid(), color, value: "0" });
      for (let n = 1; n <= 9; n++) {
        deck.push({ id: uid(), color, value: String(n) }, { id: uid(), color, value: String(n) });
      }
      for (const value of ACTION_VALUES) {
        deck.push({ id: uid(), color, value }, { id: uid(), color, value });
      }
    }
    for (let i = 0; i < 4; i++) {
      deck.push({ id: uid(), color: "wild", value: "wild" }, { id: uid(), color: "wild", value: "wild4" });
    }
  }
  return shuffle(deck);
}

/**
 * The No Mercy deck: 168 cards. The official total is 168 but the exact split is not
 * published, so this split is our own: per colour 19 numbers (one 0, two of each 1-9) and
 * three of each action; plus 20 wilds.
 */
function makeNoMercyDeck(copies = 1) {
  const deck = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const color of COLORS) {
      deck.push({ id: uid(), color, value: "0" });
      for (let n = 1; n <= 9; n++) deck.push({ id: uid(), color, value: String(n) }, { id: uid(), color, value: String(n) });
      for (const value of NO_MERCY_COLOR_ACTIONS) for (let i = 0; i < 3; i++) deck.push({ id: uid(), color, value });
    }
    const wilds = { revdraw4: 6, draw6: 4, draw10: 4, roulette: 6 };
    for (const [value, count] of Object.entries(wilds)) for (let i = 0; i < count; i++) deck.push({ id: uid(), color: "wild", value });
  }
  return shuffle(deck);
}

/** Reshuffle the discard pile (except the top card) into a new draw pile. */
function refillDeck(room) {
  const top = room.discard.pop();
  room.deck = shuffle(room.discard);
  room.discard = top ? [top] : [];
}

function drawCards(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (!room.deck.length) refillDeck(room);
    if (!room.deck.length) break;
    drawn.push(room.deck.pop());
  }
  return drawn;
}

module.exports = {
  COLORS, ACTION_VALUES, DECK_SIZE, NO_MERCY_DECK_SIZE, isNumberCard, uid, shuffle, makeDeck, makeNoMercyDeck, drawCards
};
