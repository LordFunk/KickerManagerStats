"use strict";

/*
 * End-to-end: the real server (express + socket.io) on a real port, with real socket.io clients
 * playing a whole game. Needs the project's dependencies, so it is skipped when they are not
 * installed (run `npm install` first). The other tests use in-memory fakes instead.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const have = (name) => { try { require.resolve(name); return true; } catch { return false; } };
const missing = ["express", "socket.io", "socket.io-client"].filter(n => !have(n));

const { decide } = require("./driver");

const waitFor = async (check, what, ms = 20000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = check();
    if (value) return value;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test("two browsers and a bot play a real game over real sockets", { skip: missing.length && `run npm install first (missing: ${missing.join(", ")})` }, async (t) => {
  process.env.UNO_RATE_LIMIT = "off";
  const { io: ioClient } = require("socket.io-client");
  const { server, rooms, io } = require("../server");
  const { botDelay } = require("../src/timers");
  botDelay.min = botDelay.max = 5; // fast bots

  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const clients = [];

  const player = (name) => {
    const sock = ioClient(base, { transports: ["websocket"], forceNew: true });
    const me = { name, sock, state: null, errors: [], joined: null, leaked: false };
    sock.on("state", (s) => {
      me.state = s;
      if (s.players.some(p => "hand" in p) || (s.status === "playing" && JSON.stringify(s).includes("\"hand\"") && JSON.stringify(s).split('"hand"').length > 2)) me.leaked = true;
      const action = decide(s);
      if (action) sock.emit(...action);
    });
    sock.on("joined", (j) => { me.joined = j; });
    sock.on("errorMessage", (m) => me.errors.push(m));
    clients.push(me);
    return me;
  };

  t.after(() => {
    clients.forEach(c => c.sock.close());
    io.close();
    server.close();
  });

  // The helper pages the browser loads.
  const shared = await (await fetch(`${base}/shared.js`)).text();
  assert.match(shared, /window\.CARD_DEFS/);
  assert.match(shared, /window\.EMOTES/);
  assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);

  const alex = player("Alex");
  await waitFor(() => alex.sock.connected, "connection");
  alex.sock.emit("createRoom", { name: "Alex", settings: { targetScore: 100, jumpIn: true } });
  const { code } = await waitFor(() => alex.joined, "room creation");

  const bea = player("Bea");
  await waitFor(() => bea.sock.connected, "connection");
  bea.sock.emit("joinRoom", { name: "Bea", code });
  await waitFor(() => bea.joined, "join");

  alex.sock.emit("addBot");
  await waitFor(() => alex.state?.players.length === 3, "the bot to sit down");

  // Chat works across real connections.
  bea.sock.emit("chat", { text: "good luck" });
  await waitFor(() => alex.state.chat.some(c => c.text === "good luck"), "chat");

  alex.sock.emit("startGame");
  await waitFor(() => alex.state.status === "playing", "the game to start");

  // Bea drops her connection in the middle of the game and takes her seat back with her token.
  await waitFor(() => bea.state.round >= 1, "first state");
  const token = bea.joined.token;
  bea.sock.close();
  const back = player("Bea again");
  await waitFor(() => back.sock.connected, "reconnection");
  back.sock.emit("rejoinRoom", { code, token });
  await waitFor(() => back.state?.me?.id === bea.joined.playerId, "the seat to come back");

  await waitFor(() => alex.state.status === "finished" || alex.state.status === "lobby", "the round to end", 60000);
  const finalState = alex.state;
  assert.equal(finalState.status, "finished");
  assert.ok(finalState.winner);
  assert.equal(finalState.reveal.length, 3);

  // Other players' hands never travelled over the wire.
  assert.equal(clients.some(c => c.leaked), false, "a state message contained someone else's hand");
  assert.equal(alex.errors.filter(e => !/too fast|not your turn/i.test(e)).length, 0, `unexpected errors: ${alex.errors}`);

  const stats = await (await fetch(`${base}/stats`)).json();
  assert.ok(stats.players.some(p => p.name === "Alex"), "the finished round was counted");
  assert.ok(!stats.players.some(p => /^Bot/.test(p.name)), "bots are not counted");
});
