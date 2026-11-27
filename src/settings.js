"use strict";

const scoring = require("./scoring");

const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 180;

/** 0 means "no turn timer". Anything else is clamped to a sensible range. */
function sanitizeTurnSeconds(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_TURN_SECONDS, Math.max(MIN_TURN_SECONDS, n));
}

/** Turn untrusted client input into a complete, valid settings object. */
function sanitizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const noMercy = r.noMercy === true;
  const settings = {
    noMercy,
    // house rules (on by default)
    stacking: r.stacking !== false,
    stackWild4: r.stackWild4 === true,
    stackSkips: r.stackSkips !== false,
    mustCallUno: r.mustCallUno !== false,
    drawOne: r.drawOne !== false,
    // extra rules (off by default)
    jumpIn: r.jumpIn === true,
    sevenZero: r.sevenZero === true,
    forcedPlay: r.forcedPlay === true,
    challengeWild4: r.challengeWild4 === true,
    // table
    turnSeconds: sanitizeTurnSeconds(r.turnSeconds),
    teams: r.teams === true,
    // scoring
    scoringMode: r.scoringMode === "penalty" ? "penalty" : "winner",
    targetScore: scoring.sanitizeTargetScore(r.targetScore)
  };

  // No Mercy is its own game: these rules are part of it and cannot be switched off.
  if (noMercy) {
    Object.assign(settings, {
      stacking: true, stackSkips: true, sevenZero: true,
      drawOne: false, forcedPlay: false, challengeWild4: false, teams: false, scoringMode: "winner"
    });
  }
  return settings;
}

module.exports = { sanitizeSettings, sanitizeTurnSeconds, MIN_TURN_SECONDS, MAX_TURN_SECONDS };
