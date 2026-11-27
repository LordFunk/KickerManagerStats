"use strict";

const scoring = require("./scoring");
const { current, topCard, canPlay, canJumpIn } = require("./rules");

const LOG_LINES_SENT = 30;
const CHAT_LINES_SENT = 30;

/**
 * What one client is allowed to see. Other players' hands are never included
 * (except the final reveal once a round is over), and neither are secrets such
 * as reconnect tokens or whether a +4 was legal.
 */
function publicState(room, socketId) {
  const me = room.players.find(p => p.socketId === socketId);
  const spectator = !me && room.spectators.some(s => s.socketId === socketId);
  const teams = room.settings.teams;
  const finished = room.status === "finished";

  const challenge = room.challenge
    ? { targetId: room.challenge.targetId, offenderName: room.players.find(p => p.id === room.challenge.playerId)?.name }
    : null;

  const myTurn = room.status === "playing" && !!me && !room.roulette && current(room)?.id === me.id;
  // Which cards this player may play right now. The browser only displays this, it never works it out.
  const playable = me && room.status === "playing" && !me.eliminated
    ? me.hand.filter(c => (myTurn && (me.forcedCardId ? c.id === me.forcedCardId : canPlay(c, room))) || canJumpIn(c, room)).map(c => c.id)
    : [];

  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, count: p.hand.length, connected: p.connected,
      isHost: p.id === room.hostId, bot: !!p.bot, isTurn: room.status === "playing" && i === room.turn,
      team: teams ? scoring.seatTeam(i) : null,
      saidUno: p.saidUno,
      eliminated: !!p.eliminated,
      catchable: p.hand.length === 1 && !p.saidUno && Date.now() >= p.unoGraceUntil,
      unoGraceUntil: p.unoGraceUntil
    })),
    me: me ? { id: me.id, hand: me.hand, playable, saidUno: me.saidUno, forcedCardId: me.forcedCardId, eliminated: !!me.eliminated } : null,
    spectator,
    spectators: room.spectators.length,
    topCard: topCard(room),
    activeColor: room.activeColor,
    direction: room.direction,
    turn: room.turn,
    turnEndsAt: room.turnEndsAt,
    serverNow: Date.now(),
    drawPending: room.drawPending,
    drawPendingType: room.drawPendingType,
    hasDrawn: room.hasDrawn,
    challenge,
    roulette: room.roulette ? { targetId: room.roulette.targetId } : null,
    mustChooseColor: room.status === "playing" && !!me && room.roulette?.targetId === me.id,
    round: room.round,
    scores: room.scores,
    roundPoints: room.roundPoints,
    gameWinner: room.gameWinner,
    winner: room.winner,
    winnerLabel: room.winnerLabel,
    reveal: finished
      ? room.players.map((p, i) => ({
          id: p.id, name: p.name, team: teams ? scoring.seatTeam(i) : null,
          hand: p.hand, eliminated: !!p.eliminated,
          points: p.eliminated ? scoring.MERCY_BONUS : scoring.handPoints(p.hand)
        }))
      : null,
    message: room.message,
    log: room.log.slice(-LOG_LINES_SENT),
    chat: room.chat.slice(-CHAT_LINES_SENT),
    canPlay: myTurn
  };
}

/** The small update every socket in the room gets, including the lobby screen. */
function lobbyState(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, count: p.hand.length, connected: p.connected, isHost: p.id === room.hostId, bot: !!p.bot,
      team: room.settings.teams ? scoring.seatTeam(i) : null
    })),
    spectators: room.spectators.length,
    settings: room.settings
  };
}

module.exports = { publicState, lobbyState };
