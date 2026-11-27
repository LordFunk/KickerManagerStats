"use strict";

const crypto = require("crypto");
const game = require("./game");
const { armTurnTimer, clearTurnTimer, armBotTimer, clearBotTimer } = require("./timers");
const { addChat } = require("./chat");
const { botName } = require("./bot");
const { publicState, lobbyState } = require("./state");
const { createBucket } = require("./rateLimit");
const { cleanName, newPlayer, newBot, newSpectator, newRoom } = require("./room");

const MAX_PLAYERS = 20;
const MAX_SPECTATORS = 30;
const MAX_ROOMS = 1000;
const GRACE_MS = 30 * 1000; // how long a dropped connection keeps its seat before it counts as gone
const ABANDONED_ROOM_MS = 6 * 60 * 60 * 1000;

// Per connection. `entry` (create / join / rejoin) is strict so room codes cannot be guessed quickly.
const DEFAULT_LIMITS = {
  action: { perSecond: 10, burst: 25 },
  entry: { perSecond: 0.5, burst: 5 },
  chat: { perSecond: 1, burst: 5 }
};

// No 0/O or 1/I, so codes are easy to read out loud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireHost(room, player) {
  if (room.hostId !== player.id) throw new Error("Only the room host can do that.");
}

/**
 * Connects socket.io to the game. Returns helpers so the server entry point
 * (and the tests) can restore saved rooms and inspect timers.
 */
function createSocketLayer({
  io, rooms, onChange = () => {}, graceMs = GRACE_MS, abandonedMs = ABANDONED_ROOM_MS,
  limits = DEFAULT_LIMITS, // pass null to switch rate limiting off (tests only)
  stats = null
}) {
  const dropTimers = new Map();  // member id -> timeout
  const pruneTimers = new Map(); // room code -> timeout

  /* ---------------------------------------------------------------- */
  /* Broadcasting                                                     */
  /* ---------------------------------------------------------------- */
  function emitRoom(room) {
    armTurnTimer(room, commit); // before sending, so the clients get the new deadline
    armBotTimer(room, commit);
    const send = (m) => m.socketId && io.to(m.socketId).emit("state", publicState(room, m.socketId));
    room.players.forEach(send);
    room.spectators.forEach(send);
    io.to(room.code).emit("lobby", lobbyState(room));
    onChange(room);
  }

  /** Broadcast after a real game action, and remember what happened in the log. */
  function commit(room) {
    game.recordMessage(room);
    stats?.record(room);
    emitRoom(room);
  }

  /* ---------------------------------------------------------------- */
  /* Room lifecycle                                                   */
  /* ---------------------------------------------------------------- */
  function deleteRoom(room) {
    clearTurnTimer(room);
    clearBotTimer(room);
    clearTimeout(pruneTimers.get(room.code));
    pruneTimers.delete(room.code);
    rooms.delete(room.code);
    onChange(room);
  }

  function pruneIfAbandoned(room) {
    if (room.players.some(p => p.connected && !p.bot)) return; // bots alone do not keep a room alive
    clearTimeout(pruneTimers.get(room.code));
    const handle = setTimeout(() => {
      pruneTimers.delete(room.code);
      if (rooms.get(room.code) === room && !room.players.some(p => p.connected && !p.bot)) deleteRoom(room);
    }, abandonedMs);
    handle.unref?.();
    pruneTimers.set(room.code, handle);
  }

  /** What to do once somebody has been gone longer than the grace period. */
  function settleAbsence(room, member) {
    if (room.spectators.includes(member)) {
      room.spectators = room.spectators.filter(s => s !== member);
      emitRoom(room);
      return;
    }

    if (room.status === "lobby") {
      room.players = room.players.filter(p => p !== member);
      if (!room.players.some(p => !p.bot)) { deleteRoom(room); return; }
      if (room.hostId === member.id) {
        room.hostId = (room.players.find(p => p.connected && !p.bot) ?? room.players.find(p => !p.bot)).id;
      }
    } else if (room.hostId === member.id) {
      // Mid-game the seat stays, but the host role moves to someone who is still here (never a bot).
      const heir = room.players.find(p => p !== member && p.connected && !p.bot);
      if (heir) room.hostId = heir.id;
    }
    emitRoom(room);
  }

  function cancelDrop(memberId) {
    clearTimeout(dropTimers.get(memberId));
    dropTimers.delete(memberId);
  }

  function scheduleDrop(room, member) {
    cancelDrop(member.id);
    const handle = setTimeout(() => {
      dropTimers.delete(member.id);
      if (member.connected || rooms.get(room.code) !== room) return;
      settleAbsence(room, member);
    }, graceMs);
    handle.unref?.();
    dropTimers.set(member.id, handle);
  }

  /** Re-attach a room that was loaded from disk (nobody is connected yet). */
  function adoptRoom(room) {
    room.notify = () => emitRoom(room);
    room.players.filter(p => !p.bot).forEach(p => scheduleDrop(room, p));
    pruneIfAbandoned(room);
  }

  function enterRoom(socket, room, member, { spectator = false } = {}) {
    socket.data.roomCode = room.code;
    socket.data.memberId = member.id;
    socket.join(room.code);
    socket.emit("joined", { code: room.code, playerId: member.id, token: member.token, spectator });
    emitRoom(room);
  }

  function handleDisconnect(socket) {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const member = [...room.players, ...room.spectators].find(m => m.id === socket.data.memberId);
    // A newer connection may already have taken this seat over: then there is nothing to do.
    if (!member || member.socketId !== socket.id) return;

    member.connected = false;
    member.socketId = null;
    scheduleDrop(room, member);
    emitRoom(room); // also starts the "away" timer if it was this player's turn
    pruneIfAbandoned(room);
  }

  /* ---------------------------------------------------------------- */
  /* Socket events                                                    */
  /* ---------------------------------------------------------------- */
  function roomFor(socket) {
    const room = rooms.get(socket.data.roomCode);
    if (!room) throw new Error("Room not found. Create or join another room.");

    const player = room.players.find(p => p.id === socket.data.memberId);
    if (player) {
      if (player.socketId !== socket.id) throw new Error("This seat is now used by another tab.");
      return { room, player };
    }
    if (room.spectators.some(s => s.id === socket.data.memberId)) throw new Error("Spectators can only watch.");
    throw new Error("You are no longer in this room.");
  }

  io.on("connection", socket => {
    const bucketFor = (config) => (limits ? createBucket(config) : { take: () => true });
    const actionBucket = bucketFor(limits?.action);
    const entryBucket = bucketFor(limits?.entry);
    const chatBucket = bucketFor(limits ? (limits.chat ?? DEFAULT_LIMITS.chat) : undefined);

    const guarded = (bucket, run) => {
      if (!bucket.take()) {
        socket.emit("errorMessage", "You are doing that too fast. Wait a moment.");
        return;
      }
      try { run(); } catch (e) { socket.emit("errorMessage", e.message); }
    };

    /** A game action: runs against the player's room, then broadcasts. */
    const on = (event, handler) => {
      socket.on(event, (payload) => guarded(actionBucket, () => {
        const { room, player } = roomFor(socket);
        handler(room, player, payload && typeof payload === "object" ? payload : {});
        commit(room);
      }));
    };

    socket.on("createRoom", (payload) => guarded(entryBucket, () => {
      if (rooms.size >= MAX_ROOMS) throw new Error("The server is full. Try again later.");
      const { name, settings } = payload || {};
      let code;
      do { code = roomCode(); } while (rooms.has(code));

      const host = newPlayer(socket.id, cleanName(name));
      const room = newRoom({ code, host, settings });
      room.notify = () => emitRoom(room);
      rooms.set(code, room);
      enterRoom(socket, room, host);
    }));

    socket.on("joinRoom", (payload) => guarded(entryBucket, () => {
      const { code, name } = payload || {};
      const room = rooms.get(String(code || "").trim().toUpperCase());
      if (!room) throw new Error("Room not found. Check the code.");
      const memberName = cleanName(name);

      // Joining a game that is already running means watching it.
      if (room.status !== "lobby") {
        if (room.spectators.length >= MAX_SPECTATORS) throw new Error("This game has too many spectators.");
        const spectator = newSpectator(socket.id, memberName);
        room.spectators.push(spectator);
        enterRoom(socket, room, spectator, { spectator: true });
        return;
      }

      if (room.players.length >= MAX_PLAYERS) throw new Error(`This room is full (${MAX_PLAYERS} players maximum).`);
      if (room.players.some(p => p.name.toLowerCase() === memberName.toLowerCase())) {
        throw new Error("That name is already taken in this room.");
      }
      const player = newPlayer(socket.id, memberName);
      room.players.push(player);
      enterRoom(socket, room, player);
    }));

    /** Take your seat back after a refresh, a dropped connection or a server restart. */
    socket.on("rejoinRoom", (payload) => guarded(entryBucket, () => {
      const { code, token } = payload || {};
      const room = rooms.get(String(code || "").trim().toUpperCase());
      const member = room && token
        ? [...room.players, ...room.spectators].find(m => m.token && safeEqual(m.token, token))
        : null;
      if (!member) { socket.emit("rejoinFailed"); return; }

      cancelDrop(member.id);
      member.socketId = socket.id;
      member.connected = true;
      enterRoom(socket, room, member, { spectator: room.spectators.includes(member) });
    }));

    socket.on("leaveRoom", () => {
      const room = rooms.get(socket.data.roomCode);
      const member = room && [...room.players, ...room.spectators].find(m => m.id === socket.data.memberId);
      if (!member || member.socketId !== socket.id) return;

      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.memberId = null;
      cancelDrop(member.id);

      member.connected = false;
      member.socketId = null;
      member.token = null; // the seat can no longer be reclaimed
      settleAbsence(room, member);
      if (rooms.get(room.code) === room) pruneIfAbandoned(room);
    });

    /** Chat and reactions: spectators may join in, everything else needs a seat. */
    socket.on("chat", (payload) => guarded(chatBucket, () => {
      const room = rooms.get(socket.data.roomCode);
      const member = room && [...room.players, ...room.spectators].find(m => m.id === socket.data.memberId);
      if (!member || member.socketId !== socket.id) throw new Error("You are not in a room.");
      addChat(room, member, payload && typeof payload === "object" ? payload : {});
      emitRoom(room); // not a game move, so it stays out of the game log
    }));

    on("addBot", (room, player) => {
      requireHost(room, player);
      if (room.status !== "lobby") throw new Error("Bots can only join before the game starts.");
      if (room.players.length >= MAX_PLAYERS) throw new Error(`This room is full (${MAX_PLAYERS} players maximum).`);
      const bot = newBot(botName(room));
      room.players.push(bot);
      room.message = `${bot.name} joined the table.`;
    });

    on("removeBot", (room, player, { playerId }) => {
      requireHost(room, player);
      if (room.status !== "lobby") throw new Error("Bots can only be removed before the game starts.");
      const bot = room.players.find(p => p.id === playerId && p.bot);
      if (!bot) throw new Error("That bot is not here.");
      room.players = room.players.filter(p => p !== bot);
      room.message = `${bot.name} left the table.`;
    });

    on("startGame", (room, player) => {
      requireHost(room, player);
      if (room.status !== "lobby") throw new Error("The game has already started.");
      game.startGame(room);
    });

    on("nextRound", (room, player) => {
      requireHost(room, player);
      if (room.status !== "finished") throw new Error("The round is still running.");
      if (room.gameWinner) throw new Error("The game is over. Start a new game.");
      game.startRound(room);
    });

    on("newGame", (room, player) => {
      requireHost(room, player);
      if (room.status !== "finished") throw new Error("Finish the current round first.");
      game.startGame(room);
    });

    on("playCard", (room, player, { cardId, color, targetId }) => {
      game.playCard(room, player, String(cardId), { color, targetId });
    });

    on("drawCard", game.drawAction);
    on("passTurn", game.passAction);
    on("chooseColor", (room, player, { color }) => game.rouletteAction(room, player, color));
    on("challengeWild4", game.challengeAction);
    on("callUno", game.callUno);
    on("catchUno", (room, player, { playerId }) => game.catchUno(room, player, playerId));

    socket.on("disconnect", () => handleDisconnect(socket));
  });

  return { emitRoom, commit, adoptRoom, deleteRoom };
}

module.exports = { createSocketLayer, DEFAULT_LIMITS, MAX_PLAYERS, MAX_SPECTATORS, GRACE_MS, ABANDONED_ROOM_MS };
