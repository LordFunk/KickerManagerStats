"use strict";

/*
 * A "player" that only uses what the server sends to a browser: it plays one of the cards the
 * server marked as playable, and draws or passes otherwise. Used by the fake-socket test and by
 * the real-server test, so both prove that the information given to the page is enough to play.
 */

const COLORS = ["red", "yellow", "green", "blue"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** What this client would do next given its latest state, or null to wait. */
function decide(s) {
  if (!s || !s.me || s.status !== "playing" || s.me.eliminated) return null;

  if (s.mustChooseColor) return ["chooseColor", { color: pick(COLORS) }];
  if (!s.canPlay) return null;

  if (s.challenge?.targetId === s.me.id && Math.random() < 0.5) return ["challengeWild4", {}];

  if (s.me.playable.length) {
    const others = s.players.filter(p => p.id !== s.me.id && !p.eliminated);
    return ["playCard", { cardId: pick(s.me.playable), color: pick(COLORS), targetId: pick(others).id }];
  }
  if (s.hasDrawn && !s.drawPending) return ["passTurn", {}];
  return ["drawCard", {}];
}

module.exports = { decide, COLORS, pick };
