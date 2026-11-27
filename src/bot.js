"use strict";

const game = require("./game");
const { COLORS } = require("./deck");
const { current, activePlayers, nextIndex, canPlay, DRAW_AMOUNTS } = require("./rules");
const scoring = require("./scoring");

const BOT_NAMES = ["Ava", "Bo", "Cleo", "Dex", "Eli", "Fox", "Gus", "Hana", "Ivo", "Juno"];
const FORGET_UNO_CHANCE = 0.15; // bots are human enough to forget sometimes
const CHALLENGE_CHANCE = 0.35;

/** Pick a name nobody in the room is using. */
function botName(room) {
  const taken = new Set(room.players.map(p => p.name.toLowerCase()));
  for (const n of BOT_NAMES) if (!taken.has(`bot ${n.toLowerCase()}`)) return `Bot ${n}`;
  for (let i = 1; ; i++) if (!taken.has(`bot ${i}`)) return `Bot ${i}`;
}

const colourCounts = (hand) => {
  const counts = Object.fromEntries(COLORS.map(c => [c, 0]));
  for (const c of hand) if (c.color !== "wild") counts[c.color] += 1;
  return counts;
};

/** The colour the bot holds most of (a random one when it has none). */
function bestColor(hand, rng) {
  const counts = colourCounts(hand);
  const most = Math.max(...Object.values(counts));
  const choices = COLORS.filter(c => counts[c] === most);
  return choices[Math.floor(rng() * choices.length)];
}

/** Higher is better. Keeps wilds for later, hurts a player who is nearly out. */
function scoreCard(card, room, player, rng) {
  const next = room.players[nextIndex(room, room.turn)];
  const threat = next && next !== player && !next.eliminated && next.hand.length <= 3;
  const counts = colourCounts(player.hand);

  let score = card.color === "wild" ? -6 : counts[card.color] * 1.2;
  score += scoring.cardPoints(card) * 0.05;
  if (DRAW_AMOUNTS[card.value]) score += threat ? 8 : 2;
  if (card.value === "skip" || card.value === "reverse" || card.value === "skipall") score += threat ? 4 : 1;
  if (player.hand.length === 2) score += 3; // go out soon
  return score + rng() * 0.6; // a little noise so bots are not predictable
}

function chooseCard(room, player, rng) {
  const playable = player.hand.filter(c => canPlay(c, room));
  if (!playable.length) return null;
  return playable.reduce((best, c) => (scoreCard(c, room, player, rng) > scoreCard(best, room, player, rng) ? c : best));
}

/** The opponent with the fewest cards: swapping gives them our (bigger) hand. */
function swapTarget(room, player) {
  return activePlayers(room).filter(p => p !== player).sort((a, b) => a.hand.length - b.hand.length)[0];
}

function playChosen(room, player, card, rng) {
  const rest = player.hand.filter(c => c !== card);
  game.playCard(room, player, card.id, {
    color: card.color === "wild" ? bestColor(rest, rng) : undefined,
    targetId: swapTarget(room, player)?.id
  });
  if (room.status === "playing" && player.hand.length === 1 && room.settings.mustCallUno && rng() > FORGET_UNO_CHANCE) {
    try { game.callUno(room, player); } catch { /* the window may already be gone */ }
  }
}

/** One step of a bot's turn: play, draw, pass, name a colour or challenge. */
function step(room, player, rng) {
  if (room.roulette?.targetId === player.id) {
    game.rouletteAction(room, player, bestColor(player.hand, rng));
    return;
  }
  if (room.challenge?.targetId === player.id && rng() < CHALLENGE_CHANCE) {
    game.challengeAction(room, player);
    return;
  }
  if (player.forcedCardId) {
    playChosen(room, player, player.hand.find(c => c.id === player.forcedCardId), rng);
    return;
  }
  const card = chooseCard(room, player, rng);
  if (card) {
    playChosen(room, player, card, rng);
  } else if (room.hasDrawn && !room.drawPending) {
    game.passAction(room, player);
  } else {
    game.drawAction(room, player);
  }
}

/**
 * Let the bot whose turn it is do one thing. Never throws: if the plan fails it falls back to
 * drawing, then passing, then the same automatic move used for timed-out players.
 * Returns true when it acted.
 */
function playBotStep(room, rng = Math.random) {
  if (room.status !== "playing") return false;
  const player = current(room);
  if (!player?.bot || player.eliminated) return false;

  for (const attempt of [() => step(room, player, rng), () => game.drawAction(room, player), () => game.passAction(room, player)]) {
    try { attempt(); return true; } catch { /* try the next option */ }
  }
  game.autoPlay(room);
  return true;
}

module.exports = { BOT_NAMES, botName, playBotStep, chooseCard, bestColor };
