"use strict";

/*
 * Browser check of the real client (public/) against a fake socket.io.
 * Needs Playwright and Chromium; the whole file is skipped when they are missing.
 * Setup:  npm install && npx playwright install chromium
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

let chromium = null;
try { ({ chromium } = require("playwright")); } catch { /* optional */ }

const ROOT = path.join(__dirname, "..", "public");
const FAKE_IO = `window.io = () => { const h = {}; window.__emitted = [];
  window.__fire = (e, p) => h[e] && h[e](p);
  return { id: "me", on(e, cb) { h[e] = cb; }, emit(e, p) { window.__emitted.push([e, p]); } }; };`;

const card = (id, color, value) => ({ id, color, value });
const settings = {
  stacking: true, stackWild4: false, stackSkips: true, mustCallUno: true, drawOne: true, jumpIn: true,
  sevenZero: true, forcedPlay: false, challengeWild4: true, turnSeconds: 30, teams: false,
  scoringMode: "winner", targetScore: 500
};
const players = [
  { id: "me", name: "Alex", count: 3, isTurn: true, connected: true, team: null },
  { id: "p2", name: "Sam", count: 5, isTurn: false, connected: true, team: null },
  { id: "p3", name: "Robin", count: 2, isTurn: false, connected: true, team: null }
];
const base = {
  code: "ABCD", hostId: "me", status: "playing", settings, players, spectator: false, spectators: 0,
  me: { id: "me", hand: [card("a", "red", "7"), card("b", "wild", "wild4"), card("c", "green", "2")], saidUno: false, forcedCardId: null },
  topCard: card("t", "red", "3"), activeColor: "red", direction: 1, turn: 0, drawPending: 0, drawPendingType: null,
  hasDrawn: false, challenge: null, round: 2, roundPoints: null, gameWinner: null, winner: null, message: "Test",
  canPlay: true, turnEndsAt: 30000, serverNow: 0, log: ["Sam played red 3", "Alex drew a card"],
  scores: [
    { id: "me", name: "Alex", members: ["me"], total: 77, rounds: [77, 0] },
    { id: "p2", name: "Sam", members: ["p2"], total: 59, rounds: [0, 59] },
    { id: "p3", name: "Robin", members: ["p3"], total: 0, rounds: [0, 0] }
  ]
};

let browser, server, port;

test("client renders every state correctly", { skip: !chromium && "playwright is not installed" }, async (t) => {
  server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/shared.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(`window.CARD_DEFS = ${JSON.stringify(require("../src/cards").CARD_DEFS)}; window.EMOTES = ${JSON.stringify(require("../src/chat").EMOTES)};`);
    }
    if (url === "/stats") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ players: [{ name: "Alex", games: 4, wins: 3, rounds: 12, roundWins: 7 }] }));
    }
    if (url === "/socket.io/socket.io.js") { res.setHeader("content-type", "text/javascript"); return res.end(FAKE_IO); }
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html");
      res.end(data);
    });
  });
  await new Promise(r => server.listen(0, r));
  port = server.address().port;

  try { browser = await chromium.launch(); } catch (e) { t.skip(`Chromium is not installed (${e.message.split("\n")[0]})`); server.close(); return; }

  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    // The real server says which cards are playable; here we fake that with the plain matching rule.
    const withPlayable = (s) => {
      if (!s.me || s.me.playable) return s;
      const top = s.topCard;
      const fits = (c) => c.color === "wild" || c.color === s.activeColor || c.value === top.value;
      const jump = (c) => s.settings.jumpIn && !s.drawPending && c.color !== "wild" && c.color === top.color && c.value === top.value;
      const playable = s.me.hand.filter(c => (s.canPlay && (s.me.forcedCardId ? c.id === s.me.forcedCardId : fits(c))) || jump(c)).map(c => c.id);
      return { ...s, me: { ...s.me, playable } };
    };
    const fire = (s) => page.evaluate(([x]) => window.__fire("state", x), [withPlayable(s)]);
    const last = () => page.evaluate(() => window.__emitted.pop());

    await page.goto(`http://localhost:${port}/`);

    // Create form sends every setting.
    await page.fill("#create-name", "Alex");
    await page.check("#jump-in");
    await page.selectOption("#scoring-mode", "penalty");
    assert.equal(await page.inputValue("#target-score"), "100", "penalty mode suggests a lower target");
    await page.selectOption("#turn-seconds", "20");
    await page.check("#teams");
    await page.click("#create-btn");
    const [action, payload] = await last();
    assert.equal(action, "createRoom");
    assert.equal(payload.settings.scoringMode, "penalty");
    assert.equal(payload.settings.turnSeconds, 20);
    assert.equal(payload.settings.teams, true);
    assert.equal(payload.settings.targetScore, 100);

    // Lobby, with team tags.
    await page.evaluate(([s]) => window.__fire("lobby", {
      code: "ABCD", settings: { ...s.settings, teams: true }, spectators: 2,
      players: s.players.map((p, i) => ({ ...p, isHost: p.id === "me", team: i % 2 }))
    }), [base]);
    assert.equal(await page.locator(".lobby-player .team-tag").count(), 3);
    assert.match(await page.locator("#spectator-note").innerText(), /2 watching/);
    assert.ok(await page.locator("#start-btn").isDisabled(), "teams need an even number of players");

    // Game: pickers, timer, log, sound button.
    await fire(base);
    assert.equal(await page.locator("#score-table tbody tr").count(), 3);
    assert.equal(await page.locator("#score-table tr.leader td:first-child").textContent(), "Alex (you)");
    assert.match(await page.locator("#turn-timer").innerText(), /^\d+s$/);
    assert.equal(await page.locator("#log-list li").count(), 2);
    assert.equal(await page.locator("#log-list li").first().textContent(), "Alex drew a card", "newest first");
    assert.ok(await page.locator("#challenge-btn").isHidden());

    await page.click('[data-card="a"]');
    assert.ok(await page.locator("#swap-modal").isVisible());
    await page.click('.swap-choice[data-target="p3"]');
    assert.deepEqual(await last(), ["playCard", { cardId: "a", targetId: "p3" }]);

    await page.click('[data-card="b"]');
    assert.ok(await page.locator("#color-modal").isVisible());
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#color-modal").isHidden());

    await fire({ ...base, drawPending: 4, drawPendingType: "wild4", challenge: { targetId: "me", offenderName: "Sam" } });
    assert.ok(await page.locator("#challenge-btn").isVisible());
    await page.click("#challenge-btn");
    assert.deepEqual(await last(), ["challengeWild4", undefined]);

    // Whose turn it is: a big banner, a glowing seat and a lit-up hand.
    await fire(base);
    assert.equal(await page.locator("#turn-banner-text").textContent(), "YOUR TURN");
    assert.ok(await page.locator("#turn-banner.mine").count());
    assert.equal(await page.locator("#hand-area").getAttribute("data-turn"), "yes");
    assert.match(await page.title(), /Your turn/);
    const sams = players.map(p => ({ ...p, isTurn: p.id === "p2" }));
    await fire({ ...base, canPlay: false, players: sams });
    assert.equal(await page.locator("#turn-banner-text").textContent(), "Sam's turn");
    assert.equal(await page.locator("#hand-area").getAttribute("data-turn"), "no");
    assert.equal(await page.locator("#opponents .opponent.active").count(), 1);
    assert.equal(await page.title(), "tabletop");

    // Jump-in and forced play.
    await fire({ ...base, canPlay: false, me: { ...base.me, hand: [card("j", "red", "3"), card("k", "red", "9")] } });
    assert.equal(await page.locator('[data-card="j"]:not([disabled])').count(), 1);
    assert.equal(await page.locator('[data-card="k"]:not([disabled])').count(), 0);

    await fire({ ...base, hasDrawn: true, me: { ...base.me, forcedCardId: "c", hand: [card("a", "red", "7"), card("c", "green", "3")] } });
    await page.waitForTimeout(600);
    assert.equal(await page.locator("#draw-btn").count(), 1, "animation clones must not duplicate ids");
    assert.equal(await page.locator("#my-hand .card:not([disabled])").count(), 1);

    // Round end with reveal, then game over.
    const reveal = [
      { id: "me", name: "Alex", team: null, hand: [], points: 0 },
      { id: "p2", name: "Sam", team: null, hand: [card("x", "red", "9"), card("y", "wild", "wild")], points: 59 }
    ];
    const finished = { ...base, status: "finished", canPlay: false, winner: "Alex", winnerLabel: "Alex", roundPoints: 59, reveal, turnEndsAt: null };
    await fire(finished);
    assert.match(await page.locator("#finished-banner").innerText(), /Alex takes the round/);
    assert.equal(await page.locator("#reveal .reveal-row").count(), 2);
    assert.equal(await page.locator("#reveal .mini-chip").count(), 2);
    assert.ok(await page.locator("#turn-timer").isHidden());
    assert.equal(await page.locator("#scoreboard-panel").evaluate(d => d.open), true);
    await page.click("#restart-btn");
    assert.deepEqual(await last(), ["nextRound", undefined]);

    await fire({ ...finished, gameWinner: "Alex" });
    assert.match(await page.locator("#finished-banner").innerText(), /Alex wins the game/);
    await page.click("#restart-btn");
    assert.deepEqual(await last(), ["newGame", undefined]);

    // Penalty scoring: the lowest total leads.
    await fire({ ...base, settings: { ...settings, scoringMode: "penalty", targetScore: 100 } });
    assert.equal(await page.locator("#score-table tr.leader td:first-child").textContent(), "Robin");
    assert.match(await page.locator("#score-target").textContent(), /LOWEST WINS/);

    // Spectator: no hand, no controls, but the table is visible.
    await fire({ ...base, spectator: true, me: null, canPlay: false });
    assert.ok(await page.locator("#hand-area").isHidden());
    assert.ok(await page.locator("#watching-note").isVisible());
    assert.equal(await page.locator("#opponents .opponent").count(), 3);

    // Team mode marks teammates.
    const teams = players.map((p, i) => ({ ...p, team: i % 2 }));
    await fire({ ...base, settings: { ...settings, teams: true }, players: teams });
    assert.equal(await page.locator("#opponents .teammate").count(), 1);

    // Reconnect: the saved seat is offered back on connect.
    await page.evaluate(() => window.__fire("joined", { code: "ABCD", token: "secret", spectator: false }));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("tabletop.session"))), { code: "ABCD", token: "secret" });
    await page.evaluate(() => window.__fire("connect"));
    assert.deepEqual(await last(), ["rejoinRoom", { code: "ABCD", token: "secret" }]);
    await page.evaluate(() => window.__fire("rejoinFailed"));
    assert.equal(await page.evaluate(() => localStorage.getItem("tabletop.session")), null);
    assert.ok(await page.locator("#home").isVisible());

    // Phone: 15 cards must fit without horizontal scrolling.
    await page.setViewportSize({ width: 390, height: 800 });
    const hand = Array.from({ length: 15 }, (_, i) => card(`h${i}`, ["red", "blue", "green", "yellow"][i % 4], String(i % 10)));
    await fire({ ...base, me: { ...base.me, hand } });
    assert.ok(await page.locator("#my-hand.crowded").count());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "page scrolls sideways");

    // Display options persist and apply.
    await page.click("#display-btn");
    await page.click('[data-theme="light"]');
    await page.click('[data-back="ocean"]');
    await page.check("#symbols-toggle");
    const attrs = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme, back: document.documentElement.dataset.back,
      cb: document.documentElement.classList.contains("cb"), saved: JSON.parse(localStorage.getItem("tabletop.display"))
    }));
    assert.deepEqual([attrs.theme, attrs.back, attrs.cb], ["light", "ocean", true]);
    assert.equal(attrs.saved.back, "ocean");
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#display-panel").isHidden());

    // Dragging a card upwards plays it; a short drag does not.
    await page.setViewportSize({ width: 1100, height: 900 });
    await fire({ ...base, me: { ...base.me, hand: [card("g", "red", "9"), card("c", "green", "2")] } });
    await page.locator('[data-card="g"]').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-card="g"]').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.evaluate(() => { window.__emitted.length = 0; });
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - 30, { steps: 4 }); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.__emitted), [], "a short drag must not play");
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - 120, { steps: 6 }); await page.mouse.up();
    assert.deepEqual(await last(), ["playCard", { cardId: "g" }]);

    // A new round shuffles and deals without leaving stray elements behind.
    await fire({ ...finished, round: 2 });
    await fire({ ...base, round: 3 });
    await page.waitForTimeout(2200);
    assert.equal(await page.locator("body > .card, body > .deck-back").count(), 0, "flying copies are cleaned up");
    assert.equal(await page.locator("#my-hand .card").count(), 3);

    // Winning fires confetti once.
    await page.evaluate(() => document.querySelectorAll("canvas.confetti").forEach(c => c.remove()));
    await fire({ ...base, canPlay: false });
    await fire({ ...finished, winner: "Alex", winnerLabel: "Alex" });
    assert.equal(await page.locator("canvas.confetti").count(), 1);

    // An invite link pre-fills the room code.
    const invited = await browser.newPage();
    await invited.goto(`http://localhost:${port}/?room=zx9k`);
    assert.equal(await invited.inputValue("#room-code"), "ZX9K");
    await invited.close();

    // No Mercy: presets, locked switches, new cards, roulette, penalty badge, knocked-out view.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`http://localhost:${port}/`);
    await page.click('[data-preset="nomercy"]');
    assert.equal(await page.isChecked("#no-mercy"), true);
    assert.ok(await page.locator("#seven-zero").isChecked() && await page.locator("#seven-zero").isDisabled());
    assert.equal(await page.inputValue("#target-score"), "1000");
    assert.ok(await page.locator("#scoring-mode").isDisabled());
    await page.fill("#create-name", "Alex");
    await page.click("#create-btn");
    const created = await last();
    assert.equal(created[1].settings.noMercy, true);
    assert.equal(created[1].settings.sevenZero, true);
    assert.equal(created[1].settings.turnSeconds, 60);
    await page.click('[data-preset="chaos"]');
    assert.equal(await page.isChecked("#no-mercy"), false);
    assert.ok(await page.locator("#seven-zero").isEnabled());
    assert.equal(await page.inputValue("#target-score"), "500");

    const nm = { ...base, settings: { ...settings, noMercy: true, stackSkips: true, sevenZero: true, drawOne: false, targetScore: 1000 } };
    const wildCards = [card("w1", "wild", "roulette"), card("w2", "wild", "draw10"), card("w3", "wild", "revdraw4"),
      card("s1", "red", "skipall"), card("d1", "red", "discardall"), card("f1", "blue", "draw4"), card("p1", "red", "draw2")];
    await fire({ ...nm, me: { ...nm.me, hand: wildCards } });
    assert.ok(await page.locator("#mode-tag").isVisible());
    assert.match(await page.locator("#hand-count").textContent(), /out at 25/);
    assert.equal(await page.locator("#my-hand .card").count(), 7);
    assert.equal(await page.locator("#my-hand .card[disabled]").count(), 1, "only the blue +4 does not fit a red 3");

    // A pending +6 only allows +6 or bigger, in any colour.
    await fire({ ...nm, drawPending: 6, drawPendingType: "draw6", me: { ...nm.me, hand: wildCards, playable: ["w2"] } });
    assert.equal(await page.locator("#pending-badge").textContent(), "+6");
    assert.equal(await page.locator("#my-hand .card:not([disabled])").count(), 1, "only the +10 can answer a +6");

    // Colour Roulette makes the next player name a colour, and the picker cannot be dismissed.
    await fire({ ...nm, canPlay: false, mustChooseColor: true, roulette: { targetId: "me" } });
    assert.ok(await page.locator("#color-modal").isVisible());
    assert.equal(await page.locator("#color-title").textContent(), "Name a colour");
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#color-modal").isVisible(), "must choose");
    await page.click('.color-choice[data-color="green"]');
    assert.deepEqual(await last(), ["chooseColor", { color: "green" }]);
    assert.ok(await page.locator("#color-modal").isHidden());
    await fire({ ...nm, canPlay: false, mustChooseColor: false, roulette: null });
    assert.ok(await page.locator("#color-modal").isHidden());

    // Knocked out: no hand, an OUT tag on the table, and the reveal shows the bonus.
    const outPlayers = players.map(p => p.id === "me" ? { ...p, eliminated: true, count: 0, isTurn: false } : p);
    await fire({ ...nm, canPlay: false, players: outPlayers, me: { ...nm.me, hand: [], eliminated: true } });
    assert.ok(await page.locator("#hand-area").isHidden());
    assert.match(await page.locator("#watching-title").textContent(), /out/);
    assert.equal(await page.locator("#opponents .opponent.out").count(), 1);
    await fire({ ...nm, status: "finished", canPlay: false, winner: "Sam", winnerLabel: "Sam", roundPoints: 250,
      reveal: [{ id: "me", name: "Alex", team: null, hand: [], eliminated: true, points: 250 },
               { id: "p2", name: "Sam", team: null, hand: [], eliminated: false, points: 0 }] });
    assert.match(await page.locator("#reveal").textContent(), /knocked out/);
    assert.match(await page.locator("#reveal").textContent(), /250 pts/);

    // Hall of fame, computer players, chat and reactions.
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#hall:not(.hidden)");
    assert.match(await page.locator("#hall-list").textContent(), /Alex\s+3 game wins · 7 round wins/);
    assert.ok(await page.locator("#chat-widget").isHidden(), "no chat on the home page");

    const chat = (...entries) => entries.map((e, i) => ({ id: `m${e.id ?? i}`, from: "p2", name: "Sam", ...e }));
    const botLobby = { code: "ABCD", settings, spectators: 0, players: [
      { id: "me", name: "Alex", isHost: true, connected: true, team: null },
      { id: "b1", name: "Bot Ava", isHost: false, bot: true, connected: true, team: null }] };
    await page.evaluate(([l, c]) => { window.__fire("joined", { code: "ABCD", token: "t", spectator: false, playerId: "me" }); window.__fire("state", { status: "lobby", chat: c, players: [], me: { id: "me", hand: [] }, settings: l.settings }); window.__fire("lobby", l); }, [botLobby, chat({ id: 1, text: "old news" })]);
    assert.ok(await page.locator("#add-bot").isVisible());
    assert.equal(await page.locator(".lobby-player .bot-tag").count(), 1);
    await page.click("#add-bot");
    assert.deepEqual(await last(), ["addBot", undefined]);
    await page.click('[data-remove-bot="b1"]');
    assert.deepEqual(await last(), ["removeBot", { playerId: "b1" }]);
    assert.ok(await page.locator("#chat-widget").isVisible());

    // Old messages are history; new ones from others add to the unread badge until the panel opens.
    await fire({ ...base, chat: chat({ id: 1, text: "old news" }) });
    assert.equal(await page.locator("#chat-unread").isHidden(), true, "history from before joining is not unread");
    await fire({ ...base, chat: chat({ id: 1, text: "old news" }, { id: 2, text: "<b>hi</b>" }) });
    assert.equal(await page.locator("#chat-unread").textContent(), "1");
    await page.click("#chat-toggle");
    assert.ok(await page.locator("#chat-unread").isHidden());
    assert.equal(await page.locator("#chat-list li").count(), 2);
    assert.equal(await page.locator("#chat-list b:has-text('hi')").count(), 0, "chat text is escaped");

    await page.fill("#chat-input", "hello table");
    await page.press("#chat-input", "Enter");
    assert.deepEqual(await last(), ["chat", { text: "hello table" }]);
    assert.equal(await page.inputValue("#chat-input"), "");
    await page.click('[data-emote="laugh"]');
    assert.deepEqual(await last(), ["chat", { emote: "laugh" }]);

    // A reaction from another player floats up from their seat.
    await fire({ ...base, chat: chat({ id: 1, text: "old news" }, { id: 2, text: "<b>hi</b>" }, { id: 3, emote: "fire" }) });
    assert.equal(await page.locator(".emote-bubble").count(), 1);
    assert.match(await page.locator(".emote-bubble").textContent(), /🔥/);
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#chat-panel").isHidden());

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
