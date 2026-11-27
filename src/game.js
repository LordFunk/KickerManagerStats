"use strict";

const scoring = require("./scoring");
const { COLORS, DECK_SIZE, NO_MERCY_DECK_SIZE, isNumberCard, makeDeck, makeNoMercyDeck, drawCards } = require("./deck");
const {
  current, activePlayers, nextIndex, DRAW_AMOUNTS, cardLabel, canPlay, canJumpIn,
  requireTurn, pickSwapTarget, swapHands, rotateHands
} = require("./rules");

const HAND_SIZE = 7;
const MERCY_LIMIT = 25; // No Mercy: reaching this many cards knocks you out
const UNO_GRACE_MS = 3000;
const MAX_LOG = 60;

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */
function advance(room, steps = 1) {
  room.turn = nextIndex(room, room.turn, steps);
  room.hasDrawn = false;
  room.turnSerial += 1; // a new turn: the turn timer restarts
}

/** Keep a rolling history of what happened, shown in the game log. */
function recordMessage(room) {
  if (!room.message) return;
  room.log.push(room.message);
  if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG);
}

/* ------------------------------------------------------------------ */
/* UNO call tracking                                                  */
/* ------------------------------------------------------------------ */
function clearUno(player) {
  player.saidUno = false;
  player.unoGraceUntil = 0;
}

/** Give a player with one card left a short window to call UNO. */
function startUnoGrace(room, player) {
  player.saidUno = false;
  player.unoGraceUntil = Date.now() + UNO_GRACE_MS;
  setTimeout(() => room.notify?.(), UNO_GRACE_MS + 50).unref?.();
}

/** Re-evaluate UNO state for players whose hand just changed. */
function refreshUno(room, players) {
  for (const p of players) {
    if (room.settings.mustCallUno && p.hand.length === 1) startUnoGrace(room, p);
    else clearUno(p);
  }
}

function callUno(room, player) {
  if (room.status !== "playing" || player.hand.length !== 1) throw new Error("You can only call UNO when you have one card.");
  if (player.unoGraceUntil && Date.now() > player.unoGraceUntil) throw new Error("The 3-second UNO call window has expired.");
  player.saidUno = true;
  player.unoGraceUntil = 0;
  room.message = `${player.name} called UNO!`;
}

function catchUno(room, player, targetId) {
  if (!room.settings.mustCallUno) throw new Error("UNO calls are disabled for this room.");
  const target = room.players.find(p => p.id === targetId);
  if (!target || target.id === player.id || target.hand.length !== 1 || target.saidUno || Date.now() < target.unoGraceUntil) {
    throw new Error("That player cannot be caught yet.");
  }
  target.hand.push(...drawCards(room, 2));
  clearUno(target);
  room.message = `${player.name} caught ${target.name} without calling UNO. They draw 2.`;
  enforceMercy(room);
}

/**
 * No Mercy: anyone holding MERCY_LIMIT cards or more is out for the round. Their hand is set
 * aside, and if only one player is left that player wins. Call after anything that adds cards.
 */
function enforceMercy(room) {
  if (!room.settings.noMercy || room.status !== "playing") return;

  const alive = activePlayers(room);
  let knockedOut = alive.filter(p => p.hand.length >= MERCY_LIMIT);
  if (!knockedOut.length) return;
  if (knockedOut.length === alive.length) {
    // Never knock everyone out: the player with the fewest cards survives.
    const survivor = [...knockedOut].sort((a, b) => a.hand.length - b.hand.length)[0];
    knockedOut = knockedOut.filter(p => p !== survivor);
  }

  for (const p of knockedOut) {
    p.eliminated = true;
    room.setAside.push(...p.hand);
    p.hand = [];
    p.forcedCardId = null;
    clearUno(p);
    room.message += ` ${p.name} reached ${MERCY_LIMIT} cards and is out!`;
  }

  const left = activePlayers(room);
  if (left.length === 1) {
    finishRound(room, left[0]);
    return;
  }
  if (room.roulette && room.players.find(p => p.id === room.roulette.targetId)?.eliminated) room.roulette = null;
  if (room.players[room.turn].eliminated) {
    room.roulette = null;
    advance(room, 1);
  }
}

/* ------------------------------------------------------------------ */
/* Rounds and scoring                                                 */
/* ------------------------------------------------------------------ */
function startGame(room) {
  const n = room.players.length;
  if (n < 2) throw new Error("At least two players are needed.");
  if (room.settings.teams && (n < 4 || n % 2 !== 0)) {
    throw new Error("Team mode needs an even number of players (at least 4).");
  }
  room.scores = scoring.createScoreboard(room.players, { teams: room.settings.teams });
  room.round = 0;
  room.recordedRound = 0;
  room.log = [];
  startRound(room);
}

function startRound(room) {
  const n = room.players.length;
  room.round += 1;
  room.deck = room.settings.noMercy
    ? makeNoMercyDeck(Math.ceil((n * HAND_SIZE + 60) / NO_MERCY_DECK_SIZE))
    : makeDeck(Math.ceil((n * HAND_SIZE + 20) / DECK_SIZE));
  room.discard = [];
  room.direction = 1;
  room.turn = (room.round - 1) % n; // the starting player rotates every round
  room.turnSerial += 1;
  room.turnEndsAt = null;
  room.drawPending = 0;
  room.drawPendingType = null;
  room.challenge = null;
  room.roulette = null;
  room.setAside = [];
  room.hasDrawn = false;
  room.winner = null;
  room.winnerLabel = null;
  room.roundPoints = null;
  room.roundGains = null;
  room.gameWinner = null;

  room.players.forEach(p => {
    p.hand = drawCards(room, HAND_SIZE);
    p.forcedCardId = null;
    p.eliminated = false;
    clearUno(p);
  });

  // The opening card must be a plain number card.
  const isPlain = isNumberCard;
  let first = room.deck.pop();
  for (let tries = room.deck.length; tries > 0 && !isPlain(first); tries--) {
    room.deck.unshift(first);
    first = room.deck.pop();
  }
  room.discard.push(first);
  room.activeColor = first.color === "wild" ? COLORS[0] : first.color;
  room.status = "playing";

  const starter = current(room);
  room.message = `${room.round === 1 ? "Game started." : `Round ${room.round}.`} ${starter.name} goes first.`;
}

const verb = (row, many, one) => (row.members.length > 1 ? many : one);

function finishRound(room, winner) {
  const mode = room.settings.scoringMode;
  const hands = Object.fromEntries(room.players.map(p => [p.id, p.hand]));
  const eliminated = room.players.filter(p => p.eliminated).map(p => p.id);
  const { points, gains } = scoring.scoreRound(room.scores, winner.id, hands, { mode, eliminated });
  const champion = scoring.getGameWinner(room.scores, room.settings.targetScore, mode);
  const winnerRow = room.scores.find(r => r.members.includes(winner.id));

  room.status = "finished";
  room.winner = winner.name;
  room.winnerLabel = winnerRow.name;
  room.roundPoints = points;
  room.roundGains = gains;
  room.gameWinner = champion ? champion.name : null;
  room.drawPending = 0;
  room.drawPendingType = null;
  room.challenge = null;
  room.roulette = null;

  if (mode === "penalty") {
    room.message = `${winner.name} goes out. Everyone else adds the points left in their hand.`;
    if (champion) {
      room.message += ` ${champion.name} ${verb(champion, "win", "wins")} with the lowest total (${champion.total}). Game over!`;
    }
  } else if (champion) {
    room.message = `${winnerRow.name} ${verb(winnerRow, "win", "wins")} the round (+${points}) and ` +
      `${verb(winnerRow, "reach", "reaches")} ${champion.total} points. Game over!`;
  } else {
    room.message = `${winnerRow.name} ${verb(winnerRow, "win", "wins")} the round and ` +
      `${verb(winnerRow, "score", "scores")} ${points} points.`;
  }
  if (eliminated.length) {
    room.message += ` ${eliminated.length} ${eliminated.length === 1 ? "player was" : "players were"} knocked out (${scoring.MERCY_BONUS} each).`;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */
function playCard(room, player, cardId, { color, targetId } = {}) {
  if (room.status !== "playing") throw new Error("The game is not running.");
  if (room.roulette) throw new Error("Waiting for a colour to be chosen.");

  const index = player.hand.findIndex(c => c.id === cardId);
  if (index < 0) throw new Error("That card is not in your hand.");
  const card = player.hand[index];

  const jumpingIn = current(room).id !== player.id;
  if (jumpingIn) {
    if (!canJumpIn(card, room)) throw new Error("It is not your turn.");
  } else {
    if (player.forcedCardId && player.forcedCardId !== card.id) throw new Error("You must play the card you just drew.");
    if (!canPlay(card, room)) throw new Error("That card cannot be played right now.");
  }

  const isWild = card.color === "wild";
  if (isWild && !COLORS.includes(color)) throw new Error("Choose a colour.");

  // 7-0: validate the swap target before anything is changed.
  const isLastCard = player.hand.length === 1;
  const swapTarget = room.settings.sevenZero && card.value === "7" && !isLastCard
    ? pickSwapTarget(room, player, targetId)
    : null;

  /* --- the card is legal: apply it --- */
  if (jumpingIn) room.turn = room.players.indexOf(player);
  room.players.forEach(p => { p.forcedCardId = null; });
  room.challenge = null;

  const previousColor = room.activeColor;
  const freshPenalty = room.drawPending === 0;

  player.hand.splice(index, 1);
  room.discard.push(card);
  room.activeColor = isWild ? color : card.color;
  room.hasDrawn = false;
  room.message = `${player.name} ${jumpingIn ? "jumped in with" : "played"} ${cardLabel(card)}` +
    `${isWild ? " and chose " + color : ""}.`;

  const next = room.players[nextIndex(room, room.turn)];

  if (isLastCard) {
    // A final +2 / +4 still makes the next player draw before points are counted.
    if (card.value in DRAW_AMOUNTS) {
      next.hand.push(...drawCards(room, room.drawPending + DRAW_AMOUNTS[card.value]));
    }
    finishRound(room, player);
    return;
  }

  // 7-0 hand swaps
  const changed = [player];
  if (swapTarget) {
    swapHands(player, swapTarget);
    changed.push(swapTarget);
    room.message += ` They swap hands with ${swapTarget.name}.`;
  } else if (room.settings.sevenZero && card.value === "0") {
    rotateHands(room);
    changed.push(...room.players.filter(p => p !== player));
    room.message += " Everyone passes their hand along.";
  }

  if (card.value === "discardall") {
    const dumped = player.hand.filter(c => c.color === card.color);
    if (dumped.length) {
      player.hand = player.hand.filter(c => c.color !== card.color);
      room.discard.splice(room.discard.length - 1, 0, ...dumped); // tucked under the played card
      room.message += ` They also discard ${dumped.length} more ${card.color} card${dumped.length === 1 ? "" : "s"}.`;
    }
    if (!player.hand.length) {
      finishRound(room, player);
      return;
    }
  }

  refreshUno(room, changed);
  if (room.settings.mustCallUno && player.hand.length === 1) room.message += ` ${player.name} has 3 seconds to call UNO.`;

  // Card effects
  switch (card.value) {
    case "reverse":
      room.direction *= -1;
      advance(room, activePlayers(room).length === 2 ? 2 : 1);
      break;

    case "skip":
      advance(room, 2);
      break;

    case "skipall":
      room.message += " Everyone else is skipped. They play again.";
      advance(room, 0);
      break;

    case "roulette":
      room.roulette = { playerId: player.id, targetId: next.id };
      room.message += ` ${next.name} must name a colour.`;
      advance(room, 1);
      break;

    case "discardall":
      advance(room, 1);
      break;

    case "revdraw4": {
      room.direction *= -1;
      room.drawPending += 4;
      room.drawPendingType = card.value;
      // With only two players the reversal sends the penalty back to the player who played it.
      advance(room, activePlayers(room).length === 2 ? 0 : 1);
      room.message += ` Direction reverses and ${current(room).name} faces ${room.drawPending} cards.`;
      break;
    }

    case "draw2":
    case "draw4":
    case "draw6":
    case "draw10":
    case "wild4": {
      const amount = DRAW_AMOUNTS[card.value];
      // With challenges on, a +4 always waits for the next player's answer.
      const deferred = room.settings.stacking || (card.value === "wild4" && room.settings.challengeWild4);

      if (deferred) {
        room.drawPending += amount;
        room.drawPendingType = card.value;
        if (card.value === "wild4" && room.settings.challengeWild4 && freshPenalty) {
          room.challenge = {
            playerId: player.id,
            targetId: next.id,
            // Illegal if the player still holds a card of the colour that was active.
            hadColor: player.hand.some(c => c.color === previousColor)
          };
        }
        advance(room, 1);
      } else {
        next.hand.push(...drawCards(room, amount));
        clearUno(next);
        room.message += ` ${next.name} draws ${amount} and misses a turn.`;
        advance(room, 2);
      }
      break;
    }

    default:
      advance(room, 1);
  }

  enforceMercy(room);
}

function drawAction(room, player) {
  requireTurn(room, player);
  if (room.roulette) throw new Error("A colour must be chosen first.");
  if (player.forcedCardId) throw new Error("You must play the card you just drew.");

  // Taking a pending penalty (this also means accepting an unchallenged +4).
  if (room.drawPending > 0) {
    const count = room.drawPending;
    player.hand.push(...drawCards(room, count));
    clearUno(player);
    room.drawPending = 0;
    room.drawPendingType = null;
    room.challenge = null;
    room.message = `${player.name} drew ${count} cards and misses a turn.`;
    advance(room, 1);
    enforceMercy(room);
    return;
  }

  if (room.settings.noMercy) {
    drawUntilPlayable(room, player);
    return;
  }

  const [card] = drawCards(room, 1);
  room.hasDrawn = true;

  if (!card) {
    room.message = "The draw pile is empty. You may pass.";
    return;
  }

  player.hand.push(card);
  room.message = `${player.name} drew a card.`;

  if (room.settings.forcedPlay && canPlay(card, room)) {
    player.forcedCardId = card.id;
    room.message += " It is playable, so it must be played.";
  } else if (room.settings.drawOne) {
    advance(room, 1);
  } else if (player.hand.some(c => canPlay(c, room))) {
    room.message += " You have a playable card.";
  }
}

/** No Mercy: keep drawing until a card can be played (that card must then be played). */
function drawUntilPlayable(room, player) {
  let drawn = 0;
  let playable = null;
  while (player.hand.length < MERCY_LIMIT) {
    const [card] = drawCards(room, 1);
    if (!card) break;
    player.hand.push(card);
    drawn += 1;
    if (canPlay(card, room)) { playable = card; break; }
  }

  room.hasDrawn = true;
  clearUno(player);
  if (playable) {
    player.forcedCardId = playable.id;
    room.message = `${player.name} drew ${drawn} card${drawn === 1 ? "" : "s"} to find a playable one.`;
  } else {
    room.message = drawn ? `${player.name} drew ${drawn} cards and still cannot play.` : "The draw pile is empty. You may pass.";
  }
  enforceMercy(room);
}

/** Colour Roulette: the next player names a colour and keeps drawing until that colour appears. */
function rouletteAction(room, player, color) {
  const pending = room.roulette;
  if (!pending || pending.targetId !== player.id) throw new Error("There is no colour to choose.");
  if (!COLORS.includes(color)) throw new Error("Choose a colour.");

  room.roulette = null;
  room.activeColor = color;

  const taken = [];
  for (;;) {
    const [card] = drawCards(room, 1);
    if (!card) break;
    taken.push(card);
    if (card.color === color) break;
  }
  player.hand.push(...taken);
  clearUno(player);
  room.message = `${player.name} named ${color} and took ${taken.length} card${taken.length === 1 ? "" : "s"} to find it. They miss a turn.`;
  advance(room, 1);
  enforceMercy(room);
}

function passAction(room, player) {
  requireTurn(room, player);
  if (room.roulette) throw new Error("A colour must be chosen first.");
  if (room.drawPending) throw new Error("You must take the penalty cards.");
  if (player.forcedCardId) throw new Error("You must play the card you just drew.");
  if (!room.hasDrawn) throw new Error("Draw a card before passing.");
  advance(room, 1);
  room.message = `${player.name} passed.`;
}

function challengeAction(room, player) {
  const c = room.challenge;
  if (!c || c.targetId !== player.id || current(room).id !== player.id) {
    throw new Error("There is nothing to challenge.");
  }

  const offender = room.players.find(p => p.id === c.playerId);
  room.challenge = null;
  room.drawPending = 0;
  room.drawPendingType = null;

  if (c.hadColor) {
    offender.hand.push(...drawCards(room, 4));
    clearUno(offender);
    room.message = `${player.name} challenged ${offender.name}'s +4 and was right! ${offender.name} draws 4.`;
  } else {
    player.hand.push(...drawCards(room, 6));
    clearUno(player);
    room.message = `${player.name}'s challenge failed. They draw 6 and miss a turn.`;
    advance(room, 1);
  }
}

/* ------------------------------------------------------------------ */
/* Automatic turns (turn timer expired, or the player is away)        */
/* ------------------------------------------------------------------ */
function mostCommonColor(hand) {
  const counts = Object.fromEntries(COLORS.map(c => [c, 0]));
  hand.forEach(c => { if (c.color in counts) counts[c.color] += 1; });
  return COLORS.reduce((best, c) => (counts[c] > counts[best] ? c : best), COLORS[0]);
}

function playOnBehalf(room, player, card) {
  const others = room.players.filter(p => p !== player).sort((a, b) => a.hand.length - b.hand.length);
  playCard(room, player, card.id, {
    color: mostCommonColor(player.hand.filter(c => c !== card)),
    targetId: others[0]?.id
  });
}

/**
 * Take the current player's turn for them.
 *  - Someone who simply ran out of time draws (and passes): the timer is a penalty.
 *  - Someone who is away (disconnected) plays a legal card, so the game keeps moving.
 */
function autoPlay(room) {
  const player = current(room);
  const serial = room.turnSerial;
  const away = !player.connected;

  try {
    if (room.roulette?.targetId === player.id) {
      rouletteAction(room, player, mostCommonColor(player.hand));
      return finishAuto(room, player, away);
    }
    const forced = player.forcedCardId && player.hand.find(c => c.id === player.forcedCardId);
    const playable = away && !room.drawPending ? player.hand.filter(c => canPlay(c, room)) : [];
    const choice = forced || playable.find(c => c.color !== "wild") || playable[0];

    if (choice) {
      playOnBehalf(room, player, choice);
    } else {
      drawAction(room, player);
      if (room.status === "playing" && room.turnSerial === serial) {
        const drawn = player.forcedCardId && player.hand.find(c => c.id === player.forcedCardId);
        if (drawn) playOnBehalf(room, player, drawn);
        else if (room.hasDrawn) passAction(room, player);
      }
    }
  } catch {
    /* fall through to the safety net below */
  }

  // Whatever happened, the turn must not stay stuck on this player.
  if (room.status === "playing" && room.turnSerial === serial) advance(room, 1);

  finishAuto(room, player, away);
}

function finishAuto(room, player, away) {
  room.message = `${player.name} ${away ? "is away" : "ran out of time"}. ${room.message}`;
}

module.exports = {
  HAND_SIZE, UNO_GRACE_MS, advance, recordMessage, startGame, startRound, finishRound,
  playCard, drawAction, passAction, challengeAction, rouletteAction, callUno, catchUno, autoPlay, clearUno, enforceMercy, MERCY_LIMIT
};
