"use strict";

/*
 * The single place that describes the special cards. The server (rules, scoring, messages)
 * and the browser (symbols, spoken names) both read this table; the browser gets it from
 * /cards.js. Number cards (0-9) are not listed: they score their face value.
 *
 *   label   shown in game messages
 *   symbol  printed on the card
 *   word    how a screen reader names it
 *   points  official UNO value left in a hand
 *   draw    cards the next player must draw (only for penalty cards)
 */
const CARD_DEFS = {
  skip:       { label: "Skip",            symbol: "⊘",   word: "skip",                   points: 20 },
  reverse:    { label: "Reverse",         symbol: "↻",   word: "reverse",                points: 20 },
  draw2:      { label: "+2",              symbol: "+2",  word: "draw two",               points: 20, draw: 2 },
  draw4:      { label: "+4",              symbol: "+4",  word: "draw four",              points: 20, draw: 4 },
  skipall:    { label: "Skip Everyone",   symbol: "»»",  word: "skip everyone",          points: 20 },
  discardall: { label: "Discard All",     symbol: "⌧",   word: "discard all",            points: 20 },
  wild:       { label: "Wild",            symbol: "W",   word: "wild",                   points: 50 },
  wild4:      { label: "+4",              symbol: "+4",  word: "wild draw four",         points: 50, draw: 4 },
  revdraw4:   { label: "Reverse +4",      symbol: "↻+4", word: "wild reverse draw four", points: 50, draw: 4 },
  draw6:      { label: "+6",              symbol: "+6",  word: "wild draw six",          points: 50, draw: 6 },
  draw10:     { label: "+10",             symbol: "+10", word: "wild draw ten",          points: 50, draw: 10 },
  roulette:   { label: "Colour Roulette", symbol: "◎",   word: "wild colour roulette",   points: 50 }
};

/** value -> number of cards drawn, for the penalty cards only. */
const DRAW_AMOUNTS = Object.fromEntries(
  Object.entries(CARD_DEFS).filter(([, d]) => d.draw).map(([value, d]) => [value, d.draw])
);

module.exports = { CARD_DEFS, DRAW_AMOUNTS };
