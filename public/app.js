"use strict";

const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let previousState = null;
let pendingCardId = null;   // a card waiting for a colour or swap-target choice
let toastTimer = null;
let rejoining = false;      // true while we are asking the server for our old seat
let turnDeadline = null;    // local clock time at which the current turn times out
let lastLogKey = "";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEFAULT_TARGET_SCORE = 500;
const SESSION_KEY = "tabletop.session";
const TEAM_NAMES = ["A", "B"];

/* Toggle rules. `id` is the checkbox on the create form; the lobby summary uses the same list. */
const RULES = [
  { key: "noMercy",        id: "no-mercy",        label: "No Mercy" },
  { key: "stacking",       id: "stacking",        label: "Draw stacking" },
  { key: "stackWild4",     id: "stack-wild4",     label: "Stack +4" },
  { key: "stackSkips",     id: "stack-skips",     label: "Stack Skips" },
  { key: "mustCallUno",    id: "must-uno",        label: "Call UNO" },
  { key: "drawOne",        id: "draw-one",        label: "Draw one" },
  { key: "jumpIn",         id: "jump-in",         label: "Jump-in" },
  { key: "sevenZero",      id: "seven-zero",      label: "7-0 swap" },
  { key: "forcedPlay",     id: "forced-play",     label: "Forced play" },
  { key: "challengeWild4", id: "challenge-wild4", label: "Challenge +4" },
  { key: "teams",          id: "teams",           label: "Team mode" }
];

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
function show(view) {
  document.body.dataset.view = view;
  $("chat-widget").classList.toggle("hidden", view === "home");
  ["home", "lobby", "game"].forEach(id => $(id).classList.toggle("hidden", id !== view));
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const emit = (action, payload) => socket.emit(action, payload);

/** Only touch the DOM when the text really changed (keeps screen readers from repeating themselves). */
function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/** First letter of a name (safe for emoji and other multi-unit characters). */
const initial = (name) => escapeHtml([...String(name)][0]?.toUpperCase() ?? "?");

const teamTag = (team) =>
  team === null || team === undefined ? "" : `<span class="team-tag team-${team}">TEAM ${TEAM_NAMES[team]}</span>`;

/* Card symbols, spoken names and reactions come from the server (/shared.js). */
const MERCY_LIMIT = 25;
const isLong = (c) => cardText(c).length > 2;
const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
const SPECIAL_ORDER = Object.keys(CARD_DEFS);
const COLOR_MARKS = { red: "●", yellow: "▲", green: "■", blue: "◆" };

const cardText = (c) => CARD_DEFS[c.value]?.symbol ?? c.value;
const cardClass = (c) => (c.color === "wild" ? "card-wild" : `card-${c.color}`);
const cardName = (c) => `${c.color === "wild" ? "" : c.color + " "}${CARD_DEFS[c.value]?.word ?? c.value}`;

function cardSortKey(c) {
  const n = Number(c.value);
  const rank = Number.isNaN(n) ? 10 + SPECIAL_ORDER.indexOf(c.value) : n;
  return (COLOR_ORDER[c.color] ?? 9) * 100 + rank;
}

/* Fan the hand: cards overlap in a shallow arc, tilted outwards. The overlap
   shrinks as the hand grows so the whole fan always fits the screen. */
function layoutHand() {
  const hand = $("my-hand");
  const cards = [...hand.querySelectorAll(".card")];
  const n = cards.length;
  hand.classList.toggle("many", n > 6);
  hand.classList.toggle("crowded", n > 12);
  if (!n) return;

  const cs = getComputedStyle(document.documentElement);
  const cw = parseFloat(cs.getPropertyValue("--card-w")) || 76;
  const room = hand.clientWidth - 24;
  const roomy = Math.min(cw * 0.7, cw + 10);                    // spacing when there is plenty of room
  const step = n === 1 ? 0 : Math.max(7, Math.min(roomy, (room - cw) / (n - 1)));
  hand.style.setProperty("--step", `${step.toFixed(1)}px`);

  const mid = (n - 1) / 2;
  const maxT = Math.max(1, mid);
  const perCard = n === 1 ? 0 : Math.min(4.5, 34 / (n - 1));    // degrees between neighbours
  const k = Math.min(1.6, 30 / (maxT * maxT));                  // how far the ends sag
  cards.forEach((el, i) => {
    const t = i - mid;
    el.style.setProperty("--rot", `${(t * perCard).toFixed(2)}deg`);
    el.style.setProperty("--lift", `${(t * t * k).toFixed(1)}px`);
  });
}
window.addEventListener("resize", () => { if (state?.status === "playing") layoutHand(); });

/* Inner markup of a card face (used for the discard pile). */
function cardFaceHtml(c) {
  const t = cardText(c);
  const long = isLong(c) ? " long" : "";
  return `<span class="corner${long}">${t}</span><span class="card-symbol${long}">${t}</span><span class="corner bottom${long}">${t}</span><span class="cb-mark" aria-hidden="true">${COLOR_MARKS[c.color] ?? ""}</span>`;
}

function renderCard(c, playable) {
  const t = cardText(c);
  const long = isLong(c) ? " long" : "";
  return `<button class="card ${cardClass(c)} ${playable ? "" : "disabled"}" data-card="${c.id}"
      aria-label="${cardName(c)}${playable ? "" : " (not playable)"}" ${playable ? "" : "disabled"}>
    <span class="corner${long}">${t}</span><span class="card-symbol${long}">${t}</span><span class="corner bottom${long}">${t}</span>
  </button>`;
}

/* ------------------------------------------------------------------ */
/* Saved seat (so a refresh or a lost connection does not end your game) */
/* ------------------------------------------------------------------ */
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s && s.code && s.token ? s : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* storage can be blocked */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

function leaveRoom() {
  const playing = state?.status === "playing" && !state.spectator;
  if (playing && !window.confirm("Leave this game? Your seat will be played automatically.")) return;
  emit("leaveRoom");
  clearSession();
  setTimeout(() => location.reload(), 150); // give the message a moment to be sent
}

/* ------------------------------------------------------------------ */
/* Play rules (client-side hints only, the server is authoritative)   */
/* ------------------------------------------------------------------ */
/** The server decides which cards can be played; the page just shows it. */
const canPlayCard = (c, s) => !!s.me?.playable?.includes(c.id);

/* ------------------------------------------------------------------ */
/* Sound                                                              */
/* ------------------------------------------------------------------ */
function iWon(s) {
  const me = s.players.find(p => p.id === s.me?.id);
  if (!me) return false;
  if (s.settings.teams) return me.team === s.players.find(p => p.name === s.winner)?.team;
  return me.name === s.winner;
}

function playSounds(prev, s) {
  if (!prev || s.status === "lobby" || prev.status === "lobby") return;

  if (s.status === "finished" && prev.status !== "finished") {
    Sound.play(iWon(s) ? "win" : "round");
    return;
  }

  if (s.topCard && prev.topCard?.id !== s.topCard.id) Sound.play("play");
  else if ((s.me?.hand.length ?? 0) > (prev.me?.hand.length ?? 0)) Sound.play("draw");

  if (s.message !== prev.message && /called UNO/.test(s.message)) Sound.play("uno");
  if (s.canPlay && !prev.canPlay) {
    setTimeout(() => Sound.play("turn"), 180);
    try { navigator.vibrate?.(180); } catch { /* not supported */ }
  }
}

function renderMuteButton() {
  const btn = $("mute-btn");
  btn.textContent = Sound.muted ? "♪ Off" : "♪ On";
  btn.setAttribute("aria-label", Sound.muted ? "Sound off" : "Sound on");
  btn.setAttribute("aria-pressed", String(!Sound.muted));
}

/* ------------------------------------------------------------------ */
/* Turn timer                                                         */
/* ------------------------------------------------------------------ */
function updateTurnTimer() {
  const el = $("turn-timer");
  const banner = $("turn-banner");
  if (!turnDeadline || state?.status !== "playing") {
    el.classList.add("hidden");
    $("turn-banner-timer").textContent = "";
    banner.classList.remove("urgent");
    return;
  }
  const seconds = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  el.textContent = `${seconds}s`;
  el.classList.toggle("urgent", seconds <= 5);
  el.classList.remove("hidden");
  $("turn-banner-timer").textContent = `${seconds}s`;
  banner.classList.toggle("urgent", seconds <= 5);
}

function syncTurnDeadline(s) {
  // The server sends its own clock so a wrong clock on this device does not matter.
  turnDeadline = s.turnEndsAt ? Date.now() + (s.turnEndsAt - s.serverNow) : null;
  updateTurnTimer();
}

setInterval(updateTurnTimer, 250);

/* ------------------------------------------------------------------ */
/* Card animations                                                    */
/* ------------------------------------------------------------------ */

/* Where a card sits and how it is turned, ignoring its tilt: the size stays the real card size. */
function restRect(el, angle = 0) {
  const r = el.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, angle };
}

/* Angle (degrees) a hand card is fanned at. */
function cardAngle(el) {
  return parseFloat(el?.style?.getPropertyValue("--rot")) || 0;
}

/* Capture card positions before re-render; they are the animation start points. */
function captureAnimationSources() {
  if (REDUCED_MOTION || !state || state.status !== "playing") return null;

  const sources = { hand: {}, deck: null, opponents: {}, pile: null };

  // What the discard pile shows now, so it can stay put until the new card lands on it.
  const pileEl = $("top-card");
  if (pileEl && pileEl.innerHTML.trim()) {
    sources.pile = {
      className: pileEl.className, html: pileEl.innerHTML,
      symbol: pileEl.getAttribute("data-symbol"), label: pileEl.getAttribute("aria-label"),
      rotate: pileEl.style.rotate, translate: pileEl.style.translate
    };
  }

  document.querySelectorAll("#my-hand [data-card]").forEach(el => {
    sources.hand[el.dataset.card] = { rect: restRect(el, cardAngle(el)), clone: el.cloneNode(true) };
  });

  const deckEl = document.querySelector(".deck-back") || $("draw-btn");
  if (deckEl) sources.deck = { rect: restRect(deckEl, DECK_TILT), clone: deckEl.cloneNode(true) };

  document.querySelectorAll("#opponents .opponent").forEach(el => {
    const fan = el.querySelector(".opponent-fan") || el;
    sources.opponents[el.dataset.player] = { rect: fan.getBoundingClientRect() };
  });

  return sources;
}

/* Fly a visual copy of a card between two places: one smooth slide that eases
   from the card's starting tilt into the tilt it lands with. The card keeps
   its size the whole way. `dest` is an element, or {cx, cy} for a point. */
const FLY_MS = 420;
const FLY_EASING = "cubic-bezier(.4, 0, .2, 1)";
const DECK_TILT = -7;

function flyCard(clone, from, dest, delay = 0, onDone = null, toAngle = null, fadeOut = false) {
  if (!clone || !from || !dest) return false;

  let cx, cy;
  if (dest instanceof Element) {
    const r = dest.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    if (toAngle === null) toAngle = cardAngle(dest);
  } else {
    ({ cx, cy } = dest);
  }

  // The clone is decoration only: it must not duplicate ids or card data.
  [clone, ...clone.querySelectorAll("[id]")].forEach(el => el.removeAttribute("id"));
  clone.removeAttribute("data-card");
  clone.setAttribute("aria-hidden", "true");
  clone.classList.remove("card-draw-in", "card-play-in", "draw-pulse", "disabled", "dragging", "ready", "shuffling");
  clone.removeAttribute("disabled");
  Object.assign(clone.style, {
    position: "fixed", left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`,
    margin: "0", zIndex: "9999", pointerEvents: "none",
    transform: "none", rotate: "none", translate: "none", transition: "none", opacity: "1"
  });
  if (clone.classList.contains("deck-back")) clone.style.boxShadow = "0 5px 14px #0006"; // a single card, not the stack
  document.body.appendChild(clone);

  const a0 = from.angle || 0;
  const a1 = toAngle ?? 0;
  const dx = cx - (from.left + from.width / 2);
  const dy = cy - (from.top + from.height / 2);

  const animation = clone.animate([
    { transform: `translate(0px, 0px) rotate(${a0}deg)` },
    { transform: `translate(${dx}px, ${dy}px) rotate(${a1}deg)` }
  ], { duration: FLY_MS, delay, easing: FLY_EASING, fill: delay ? "both" : "forwards" });

  // A card heading into someone's small fan of cards melts into it at the very end.
  if (fadeOut) {
    clone.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
      { duration: FLY_MS, delay, easing: "linear", fill: delay ? "both" : "forwards" });
  }

  animation.onfinish = animation.oncancel = () => { clone.remove(); onDone?.(); };
  return true;
}

/* Delay between cards when several are drawn at once (kept short for big draws). */
function drawStagger(count) {
  return Math.min(130, 900 / Math.max(1, count));
}

/* Slide a card onto the discard pile. The pile keeps showing the old top card
   underneath and only switches to the new one when the flying card lands. */
function flyToPile(clone, from, sources) {
  if (!state?.topCard) return;
  const pile = $("top-card");
  const stack = $("pile-stack").getBoundingClientRect();
  const tilt = pileTilt(state.topCard.id);
  const dest = { cx: stack.left + stack.width / 2 + tilt.x, cy: stack.top + stack.height / 2 + tilt.y };

  const launched = flyCard(clone, from, dest, 0, () => { if (state) paintTopCard(state); }, tilt.angle);
  const old = sources?.pile;
  if (launched && old) {
    pile.className = old.className;
    pile.innerHTML = old.html;
    pile.style.rotate = old.rotate;
    pile.style.translate = old.translate;
    if (old.symbol != null) pile.setAttribute("data-symbol", old.symbol);
    if (old.label != null) pile.setAttribute("aria-label", old.label);
  }
}

/* Animate cards after the new state has been rendered. */
function animateStateChanges(s, sources) {
  if (!sources || !previousState || previousState.status !== "playing" || s.status !== "playing") return;

  // A hand swap changes everything at once: skip the animation rather than mislead.
  const handsChanged = /swap hands|passes their hand/.test(s.message || "");
  const oldHand = new Set(previousState.me?.hand?.map(c => c.id) || []);
  const newHand = s.me?.hand || [];

  if (!handsChanged) {
    const drawn = newHand.filter(c => !oldHand.has(c.id));
    const gap = drawStagger(drawn.length);
    drawn.forEach((card, i) => {
      const target = document.querySelector(`#my-hand [data-card="${card.id}"]`);
      if (!target || !sources.deck) return;
      target.style.opacity = "0";                       // shown again when the flying card lands
      const launched = flyCard(sources.deck.clone.cloneNode(true), sources.deck.rect, target, i * gap,
        () => { target.style.opacity = ""; });
      if (!launched) target.style.opacity = "";
    });

    // Opponents drawing: cards fly from the draw pile into their fan.
    (s.players || []).forEach(p => {
      if (p.id === s.me?.id) return;
      const old = previousState.players?.find(o => o.id === p.id);
      if (!old || p.count <= old.count || !sources.deck) return;
      const fan = document.querySelector(`#opponents .opponent[data-player="${p.id}"] .opponent-fan`);
      if (!fan) return;
      const n = Math.min(p.count - old.count, 8);
      const gap = drawStagger(n);
      for (let i = 0; i < n; i++) {
        flyCard(sources.deck.clone.cloneNode(true), sources.deck.rect, fan, i * gap, null, 0, true);
      }
    });
  }

  // A new top card means somebody played.
  if (!s.topCard || s.topCard.id === previousState.topCard?.id) return;
  const target = $("top-card");

  const remaining = new Set(newHand.map(c => c.id));
  const played = previousState.me?.hand?.find(c => !remaining.has(c.id));

  if (played && sources.hand[played.id] && !handsChanged) {
    const src = sources.hand[played.id];
    flyToPile(src.clone.cloneNode(true), src.rect, sources);
    return;
  }

  // Otherwise: the opponent whose card count dropped.
  const opponent = (s.players || []).find(p => {
    if (p.id === s.me?.id) return false;
    const old = previousState.players?.find(o => o.id === p.id);
    return old && p.count < old.count;
  });
  const src = opponent && sources.opponents[opponent.id];

  if (src && target) {
    // Fly an exact copy of the discard pile card, at its real size, starting
    // centred on the opponent's seat. (Squeezing the full card face into the
    // tiny mini card-back rectangle made its text spill out and overlap.)
    const w = target.offsetWidth, h = target.offsetHeight;
    const from = {
      left: src.rect.left + src.rect.width / 2 - w / 2,
      top: src.rect.top + src.rect.height / 2 - h / 2,
      width: w,
      height: h,
      angle: 0
    };
    flyToPile(target.cloneNode(true), from, sources);
  }
}

/* ------------------------------------------------------------------ */
/* Discard pile: the last few cards, each lying at its own angle       */
/* ------------------------------------------------------------------ */
const PILE_VISIBLE = 5;          // cards shown, including the top one
let pileHistory = [];            // recently played cards, oldest first
let pileKey = "";

function hashStr(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* A card's resting angle and offset on the pile. Derived from its id, so every player sees the same pile. */
function pileTilt(id) {
  const h = hashStr(id);
  const r = n => ((h >>> (n * 5)) & 31) / 31 * 2 - 1;
  return { angle: r(0) * 16, x: r(1) * 6, y: r(2) * 6 };
}

function applyTilt(el, card) {
  const t = pileTilt(card.id);
  el.style.rotate = `${t.angle.toFixed(1)}deg`;
  el.style.translate = `${t.x.toFixed(1)}px ${t.y.toFixed(1)}px`;
}

function trackPile(s) {
  const key = `${s.code}:${s.round}`;
  if (key !== pileKey) { pileKey = key; pileHistory = []; }
  const top = s.topCard;
  if (top && pileHistory.at(-1)?.id !== top.id) {
    pileHistory.push(top);
    if (pileHistory.length > PILE_VISIBLE + 2) pileHistory.shift();
  }
}

/* Draw the discard pile from the given state. */
function paintTopCard(s) {
  const top = s.topCard;
  if (!top) return;
  trackPile(s);

  const el = $("top-card");
  el.className = `card ${cardClass(top)} played-pile-card${isLong(top) ? " long" : ""}`;
  el.innerHTML = cardFaceHtml(top);
  el.setAttribute("data-symbol", cardText(top));
  el.setAttribute("aria-label", `Top card: ${cardName(top)}, active colour ${s.activeColor}`);
  applyTilt(el, top);

  // The cards underneath: the ones played before this one.
  const under = pileHistory.filter(c => c.id !== top.id).slice(-(PILE_VISIBLE - 1));
  $("pile-under").innerHTML = under.map(c =>
    `<div class="card ${cardClass(c)} played-pile-card${isLong(c) ? " long" : ""}" data-pile="${c.id}" aria-hidden="true">${cardFaceHtml(c)}</div>`
  ).join("");
  [...$("pile-under").children].forEach((el, i) => applyTilt(el, under[i]));
}

/* ------------------------------------------------------------------ */
/* Lobby                                                              */
/* ------------------------------------------------------------------ */
function teamsAreValid(settings, count) {
  return !settings.teams || (count >= 4 && count % 2 === 0);
}

function renderLobby(lobby) {
  $("lobby-code").textContent = lobby.code;
  $("player-count").textContent = `${lobby.players.length} / 20`;

  const amHost = lobby.players.some(p => p.isHost && p.id === state?.me?.id);
  $("lobby-players").innerHTML = lobby.players.map(p => `
    <div class="lobby-player">
      <div class="avatar">${p.bot ? "🤖" : initial(p.name)}</div>
      <div>
        <b>${escapeHtml(p.name)}</b>
        ${p.isHost ? '<span class="host-tag">HOST</span>' : ""}${p.bot ? '<span class="bot-tag">BOT</span>' : ""}${teamTag(p.team)}
        <div class="muted" style="font-size:9px">${p.bot ? "Computer player" : p.connected ? "Connected" : "Reconnecting…"}</div>
      </div>
      ${p.bot && amHost ? `<button class="remove-bot" data-remove-bot="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">✕</button>` : ""}
    </div>`).join("");
  $("add-bot").classList.toggle("hidden", !amHost || lobby.players.length >= 20);

  const s = lobby.settings || {};
  const lines = RULES.map(r => [r.label, s[r.key] ? "On" : "Off"]);
  lines.push(["Turn timer", s.turnSeconds ? `${s.turnSeconds} seconds` : "Off"]);
  lines.push(["Scoring", s.scoringMode === "penalty" ? "Penalty (lowest wins)" : "Winner scores"]);
  lines.push(["Points to win", s.targetScore ?? DEFAULT_TARGET_SCORE]);

  $("rules-summary").innerHTML = lines
    .map(([a, b]) => `<div class="rule-line"><span>${a}</span><b>${escapeHtml(b)}</b></div>`)
    .join("");

  const isHost = lobby.players.some(p => p.isHost && p.id === state?.me?.id);
  const validTeams = teamsAreValid(s, lobby.players.length);

  $("start-btn").classList.toggle("hidden", !isHost);
  $("start-btn").disabled = lobby.players.length < 2 || !validTeams;

  setText("spectator-note", lobby.spectators ? `${lobby.spectators} watching` : "");
  setText("host-tip", !isHost
    ? "Waiting for the host to start the game."
    : !validTeams
      ? "Team mode needs an even number of players (at least 4)."
      : "You are the host. Start when at least two players have joined.");
}

/* ------------------------------------------------------------------ */
/* Game                                                               */
/* ------------------------------------------------------------------ */
function unoControl(s, p, canCatch) {
  if (!s.settings.mustCallUno) return "";
  if (p.catchable && canCatch) return `<button class="catch-uno" data-catch="${p.id}">CATCH UNO</button>`;
  if (p.count === 1 && !p.saidUno) return `<span class="uno-grace">UNO…</span>`;
  return "";
}

function renderScoreboard(s) {
  const panel = $("scoreboard-panel");
  const scores = s.scores;

  if (!Array.isArray(scores) || !scores.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const penalty = s.settings.scoringMode === "penalty";
  const target = s.settings.targetScore ?? DEFAULT_TARGET_SCORE;
  const rounds = Math.max(0, ...scores.map(p => p.rounds.length));
  const totals = scores.map(p => p.total);
  const leading = penalty ? Math.min(...totals) : Math.max(...totals);
  const hasLeader = rounds > 0 && (penalty || leading > 0);
  const heads = Array.from({ length: rounds }, (_, i) => `<th>R${i + 1}</th>`).join("");

  const rows = [...scores]
    .sort((a, b) => (penalty ? a.total - b.total : b.total - a.total))
    .map(p => {
      const cells = Array.from({ length: rounds }, (_, i) => {
        const pts = p.rounds[i] ?? 0;
        return pts ? `<td class="gain">+${pts}</td>` : `<td class="zero">–</td>`;
      }).join("");
      const you = p.members?.includes(s.me?.id) ? " (you)" : "";
      return `<tr class="${hasLeader && p.total === leading ? "leader" : ""}">
        <td>${escapeHtml(p.name)}${you}</td>${cells}<td class="total">${p.total}</td></tr>`;
    }).join("");

  $("score-table").innerHTML =
    `<thead><tr><th>${s.settings.teams ? "TEAM" : "PLAYER"}</th>${heads}<th>TOTAL</th></tr></thead><tbody>${rows}</tbody>`;
  setText("score-target", penalty ? `ENDS AT ${target} · LOWEST WINS` : `FIRST TO ${target}`);

  // Open the table once when a round ends; leave it alone if the player collapses it.
  if (s.status === "finished" && previousState?.status !== "finished") panel.open = true;
}

function renderReveal(s) {
  const el = $("reveal");
  if (s.status !== "finished" || !s.reveal) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = s.reveal.map(r => {
    const chips = r.hand.map(c =>
      `<span class="mini-chip ${cardClass(c)}" title="${cardName(c)}">${cardText(c)}</span>`).join("");
    const empty = r.eliminated ? "knocked out" : "went out";
    return `<div class="reveal-row">
      <span class="reveal-name">${escapeHtml(r.name)}${teamTag(r.team)}</span>
      <span class="reveal-cards">${chips || `<span class="muted">${empty}</span>`}</span>
      <span class="reveal-points ${r.eliminated ? "out" : ""}">${r.eliminated || r.hand.length ? `${r.points} pts` : ""}</span>
    </div>`;
  }).join("");
}

function renderLog(s) {
  const lines = s.log || [];
  const key = `${lines.length}|${lines.at(-1) ?? ""}|${s.round}`;
  if (key === lastLogKey) return; // unchanged: keep the scroll position
  lastLogKey = key;

  $("log-list").innerHTML = [...lines].reverse().map(line => `<li>${escapeHtml(line)}</li>`).join("");
  setText("log-count", lines.length ? `${lines.length} MOVES` : "");
}

function renderFinishedBanner(s, isHost) {
  const finished = s.status === "finished";
  $("finished-banner").classList.toggle("hidden", !finished);
  if (!finished) return;

  const gameOver = !!s.gameWinner;
  const label = s.winnerLabel || s.winner;
  const plural = s.settings.teams;
  const penalty = s.settings.scoringMode === "penalty";

  setText("winner-text", gameOver
    ? `${s.gameWinner} ${plural ? "win" : "wins"} the game!`
    : `${label} ${plural ? "take" : "takes"} the round`);

  let note = penalty
    ? "Everyone else adds the points left in their hand."
    : `${label} ${plural ? "score" : "scores"} ${s.roundPoints ?? 0} point${s.roundPoints === 1 ? "" : "s"} this round.`;
  if (!isHost && !s.spectator) note += " Waiting for the host to continue.";
  setText("banner-note", note);

  const btn = $("restart-btn");
  btn.classList.toggle("hidden", !isHost);
  btn.textContent = gameOver ? "New game ↗" : "Next round ↗";
  btn.dataset.action = gameOver ? "newGame" : "nextRound";
}

/* A small fan of card backs, one per card held (up to a handful). */
function opponentFan(count) {
  const shown = Math.min(count, 8);
  const mid = (shown - 1) / 2;
  return Array.from({ length: shown }, (_, i) =>
    `<span class="mini-card-back" style="--t:${(i - mid).toFixed(2)}"></span>`).join("");
}

function renderOpponents(s, myTeam, showAll) {
  const myId = s.me?.id;
  $("opponents").innerHTML = s.players
    .filter(p => showAll || p.id !== myId)
    .map(p => {
      const label = p.eliminated
        ? `${p.name}, knocked out`
        : `${p.name}, ${p.count} card${p.count === 1 ? "" : "s"}${p.isTurn ? ", their turn" : ""}`;
      const mate = myTeam !== null && p.team === myTeam ? "teammate" : "";
      const danger = s.settings.noMercy && !p.eliminated && p.count >= MERCY_LIMIT - 5 ? "danger" : "";
      return `
      <div class="opponent ${p.isTurn ? "active" : ""} ${mate} ${danger} ${p.eliminated ? "out" : ""}" data-player="${p.id}" role="group" aria-label="${escapeHtml(label)}">
        <div class="avatar">${initial(p.name)}</div>
        <div class="opponent-info">
          <b>${escapeHtml(p.name)}${teamTag(p.team)}${p.bot ? '<span class="bot-tag">BOT</span>' : ""}${p.eliminated ? '<span class="out-tag">OUT</span>' : ""}</b>
          <div class="opponent-cards">
            <div class="opponent-fan" aria-hidden="true">${opponentFan(p.count)}</div>
            <strong class="opponent-count">${p.count}</strong>
          </div>
        </div>
        ${unoControl(s, p, !s.spectator && p.connected !== undefined)}
      </div>`;
    }).join("");
}

/** One big, unmistakable line saying whose turn it is. */
function renderTurnBanner(s, current, watching) {
  const banner = $("turn-banner");
  const mine = !!current && current.id === s.me?.id && s.status === "playing" && !watching;
  let kind = "other";
  let text;

  if (s.status !== "playing") {
    kind = "done";
    text = "Round over";
  } else if (s.mustChooseColor) {
    kind = "mine";
    text = "NAME A COLOUR";
  } else if (mine) {
    kind = "mine";
    text = s.drawPending ? `YOUR TURN · TAKE ${s.drawPending} OR STACK` : "YOUR TURN";
  } else if (current) {
    text = `${current.name}'s turn`;
  } else {
    text = "Waiting…";
  }

  banner.className = `turn-banner ${kind}`;
  setText("turn-banner-text", text);
  $("hand-area").dataset.turn = kind === "mine" ? "yes" : "no";
  $("game").classList.toggle("my-turn", kind === "mine");
  document.title = kind === "mine" ? "● Your turn · tabletop" : "tabletop";
}

function renderGame(s) {
  const spectator = !!s.spectator;
  const out = !!s.me?.eliminated;
  const watching = spectator || out;
  const myId = s.me?.id ?? null;
  const hand = s.me?.hand ?? [];
  const myTeam = s.players.find(p => p.id === myId)?.team ?? null;
  const isHost = !spectator && s.hostId === myId;

  setText("game-room-code", s.code);
  const clockwise = s.direction === 1;
  const direction = $("direction-indicator");
  direction.classList.toggle("counterclockwise", !clockwise);
  direction.setAttribute("aria-label", clockwise ? "Playing clockwise" : "Playing counterclockwise");
  direction.querySelector(".direction-arrow").textContent = clockwise ? "↻" : "↺";
  direction.querySelector(".direction-label").textContent = clockwise ? "CLOCKWISE" : "COUNTER-CLOCKWISE";
  if (previousState?.status === "playing" && previousState.direction !== s.direction) {
    direction.classList.remove("direction-changed");
    void direction.offsetWidth;
    direction.classList.add("direction-changed");
    setTimeout(() => direction.classList.remove("direction-changed"), 650);
  }
  $("spectator-tag").classList.toggle("hidden", !watching);
  $("spectator-tag").textContent = out ? "OUT" : "WATCHING";
  $("mode-tag").classList.toggle("hidden", !s.settings.noMercy);
  $("hand-area").classList.toggle("hidden", watching);
  $("watching-note").classList.toggle("hidden", !watching);
  setText("watching-title", out ? "You hit 25 cards and are out for this round." : "You are watching this game.");
  setText("watching-text", out ? "Sit back and enjoy the chaos until the next round." : "You can see the table but not anyone's hand. Join a new room to play.");

  renderOpponents(s, myTeam, watching);

  paintTopCard(s);

  $("active-color").style.background = `var(--${s.activeColor})`;
  $("active-color").dataset.color = s.activeColor;

  const current = s.players.find(p => p.isTurn);
  setText("turn-status",
    s.status === "finished" ? "Round complete"
    : current ? `Round ${s.round} · ${current.id === myId ? "your turn" : current.name + "'s turn"}`
    : "Waiting");

  setText("game-message", s.message || "");
  renderTurnBanner(s, current, watching);

  const sorted = [...hand].sort((a, b) => cardSortKey(a) - cardSortKey(b));
  const mercyNote = s.settings.noMercy ? ` · out at ${MERCY_LIMIT}` : "";
  setText("hand-count", `${hand.length} card${hand.length === 1 ? "" : "s"}${mercyNote}`);
  $("hand-count").classList.toggle("danger", s.settings.noMercy && hand.length >= MERCY_LIMIT - 5);

  const badge = $("pending-badge");
  badge.classList.toggle("hidden", !s.drawPending);
  badge.textContent = s.drawPending ? `+${s.drawPending}` : "";
  $("my-hand").innerHTML = sorted.map(c => renderCard(c, canPlayCard(c, s))).join("");
  layoutHand();

  const myTurn = s.canPlay;
  const forced = !!s.me?.forcedCardId;
  const canChallenge = myTurn && s.challenge?.targetId === myId;

  $("draw-btn").disabled = !myTurn || forced;
  $("draw-btn").setAttribute("aria-label", s.drawPending ? `Take ${s.drawPending} penalty cards`
    : s.settings.noMercy ? "Draw until you can play" : "Draw a card");
  $("pass-btn").disabled = !myTurn || !!s.drawPending || forced || !s.hasDrawn;
  $("uno-btn").disabled = hand.length !== 1 || !!s.me?.saidUno;
  $("challenge-btn").classList.toggle("hidden", !canChallenge);
  if (canChallenge) $("challenge-btn").title = `Challenge ${s.challenge.offenderName}'s Wild +4`;

  renderFinishedBanner(s, isHost);
  renderReveal(s);
  renderScoreboard(s);
  renderLog(s);
}

/* ------------------------------------------------------------------ */
/* Socket events                                                      */
/* ------------------------------------------------------------------ */
socket.on("connect", () => {
  // Also runs after a dropped connection: ask for our old seat back.
  const session = loadSession();
  if (session) {
    rejoining = true;
    emit("rejoinRoom", session);
  }
});

socket.on("disconnect", () => toast("Connection lost. Trying to reconnect…"));

let memberId = null;   // my id in the room (players and spectators alike)

socket.on("joined", ({ code, token, spectator, playerId }) => {
  memberId = playerId ?? memberId;
  chatPrimed = false;
  saveSession({ code, token });
  if (location.search) history.replaceState(null, "", location.pathname); // drop ?room= once joined
  toast(rejoining ? "Welcome back!" : spectator ? `Watching room ${code}` : `Joined room ${code}`);
  rejoining = false;
});

socket.on("rejoinFailed", () => {
  clearSession();
  rejoining = false;
  state = null;
  previousState = null;
  show("home");
});

socket.on("lobby", lobby => {
  if (!state || state.status === "lobby") {
    renderLobby(lobby);
    show("lobby");
  }
});

socket.on("state", s => {
  const sources = captureAnimationSources();
  previousState = state;
  state = s;
  syncTurnDeadline(s);

  if (s.status === "lobby") {
    show("lobby");
    renderChat(s);
    return;
  }

  show("game");
  renderGame(s);
  syncRouletteModal(s);

  if (isNewRound(previousState, s)) dealAnimation();
  else animateStateChanges(s, sources);

  playSounds(previousState, s);
  renderChat(s); // after the table is drawn, so a reaction can float up from the right seat
  if (s.status === "finished" && previousState?.status === "playing" && (s.gameWinner || iWon(s))) {
    confetti(!!s.gameWinner);
  }
});

socket.on("errorMessage", toast);

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */
/** Colour Roulette: the player after the card must name a colour (and cannot dismiss the picker). */
function syncRouletteModal(s) {
  const open = !$("color-modal").classList.contains("hidden");
  if (s.mustChooseColor) {
    setText("color-kicker", "COLOUR ROULETTE");
    setText("color-title", "Name a colour");
    setText("color-note", "You keep drawing until that colour turns up. Choose wisely.");
    if (!open) openModal("color-modal", ".color-choice");
  } else {
    setText("color-kicker", "WILD CARD");
    setText("color-title", "Choose a colour");
    setText("color-note", "Set the colour for the next player.");
    if (open && !pendingCardId) $("color-modal").classList.add("hidden");
  }
}

function closeModals() {
  if (state?.mustChooseColor) return;
  pendingCardId = null;
  $("color-modal").classList.add("hidden");
  $("swap-modal").classList.add("hidden");
}

function openModal(id, focusSelector) {
  $(id).classList.remove("hidden");
  $(id).querySelector(focusSelector)?.focus();
}

function openSwapPicker(s) {
  $("swap-options").innerHTML = s.players
    .filter(p => p.id !== s.me.id)
    .map(p => `<button class="swap-choice" data-target="${p.id}">
        <span>${escapeHtml(p.name)}</span><small>${p.count} card${p.count === 1 ? "" : "s"}</small>
      </button>`).join("");
  openModal("swap-modal", "button");
}

/* ------------------------------------------------------------------ */
/* UI events                                                          */
/* ------------------------------------------------------------------ */
function readSettings() {
  const settings = {};
  RULES.forEach(r => { settings[r.key] = $(r.id).checked; });

  const target = parseInt($("target-score").value, 10);
  settings.targetScore = Number.isFinite(target) ? target : DEFAULT_TARGET_SCORE;
  settings.turnSeconds = parseInt($("turn-seconds").value, 10) || 0;
  settings.scoringMode = $("scoring-mode").value;
  return settings;
}

$("create-btn").onclick = () => emit("createRoom", {
  name: $("create-name").value.trim(),
  settings: readSettings()
});

$("join-btn").onclick = () => emit("joinRoom", {
  name: $("join-name").value.trim(),
  code: $("room-code").value.trim().toUpperCase()
});

$("room-code").addEventListener("input", e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});
$("room-code").addEventListener("keydown", e => {
  if (e.key === "Enter") $("join-btn").click();
});

// Penalty games end much sooner, so suggest a lower target when the mode changes.
$("scoring-mode").addEventListener("change", e => {
  const target = $("target-score");
  if (e.target.value === "penalty" && target.value === "500") target.value = "100";
  if (e.target.value === "winner" && target.value === "100") target.value = "500";
});

/* Presets and the No Mercy switch. No Mercy brings its own rules, so those switches lock. */
const RULE_DEFAULTS = {
  noMercy: false, stacking: true, stackWild4: false, stackSkips: true, mustCallUno: true, drawOne: true,
  jumpIn: false, sevenZero: false, forcedPlay: false, challengeWild4: false, teams: false
};
const PRESETS = {
  classic: { rules: {}, turnSeconds: 0, targetScore: 500 },
  chaos: {
    rules: { stackWild4: true, jumpIn: true, sevenZero: true, forcedPlay: true, challengeWild4: true },
    turnSeconds: 30, targetScore: 500
  },
  nomercy: { rules: { noMercy: true, jumpIn: true }, turnSeconds: 60, targetScore: 1000 }
};
/* What No Mercy fixes (rules not listed here stay free). */
const NO_MERCY_LOCKED = {
  stacking: true, stackWild4: false, stackSkips: true, sevenZero: true,
  drawOne: false, forcedPlay: false, challengeWild4: false, teams: false
};
const ruleId = (key) => RULES.find(r => r.key === key).id;

function syncNoMercy() {
  const on = $("no-mercy").checked;
  Object.entries(NO_MERCY_LOCKED).forEach(([key, value]) => {
    const input = $(ruleId(key));
    if (on) input.checked = value;
    input.disabled = on;
    input.closest(".toggle-row")?.classList.toggle("locked", on);
  });
  $("scoring-mode").disabled = on;
  if (on) {
    $("scoring-mode").value = "winner";
    if ($("target-score").value === "500") $("target-score").value = "1000";
  } else if ($("target-score").value === "1000") {
    $("target-score").value = "500";
  }
}

function markPreset(name) {
  document.querySelectorAll("#preset-options [data-preset]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.preset === name)));
}

function applyPreset(name) {
  const preset = PRESETS[name];
  const rules = { ...RULE_DEFAULTS, ...preset.rules };
  RULES.forEach(r => { $(r.id).checked = !!rules[r.key]; });
  $("turn-seconds").value = String(preset.turnSeconds);
  $("scoring-mode").value = "winner";
  $("target-score").value = String(preset.targetScore);
  syncNoMercy();
  markPreset(name);
}

$("preset-options").addEventListener("click", e => {
  const b = e.target.closest("[data-preset]");
  if (b) applyPreset(b.dataset.preset);
});
$("no-mercy").addEventListener("change", () => { syncNoMercy(); markPreset(null); });
[...RULES.map(r => r.id), "turn-seconds", "scoring-mode", "target-score"].filter(id => id !== "no-mercy").forEach(id =>
  $(id).addEventListener("change", () => markPreset(null)));
applyPreset("classic");

$("start-btn").onclick = () => emit("startGame");
$("add-bot").onclick = () => emit("addBot");
$("lobby-players").addEventListener("click", e => {
  const btn = e.target.closest("[data-remove-bot]");
  if (btn) emit("removeBot", { playerId: btn.dataset.removeBot });
});
$("restart-btn").onclick = () => emit($("restart-btn").dataset.action || "nextRound");
$("draw-btn").onclick = () => emit("drawCard");
$("pass-btn").onclick = () => emit("passTurn");
$("uno-btn").onclick = () => emit("callUno");
$("challenge-btn").onclick = () => emit("challengeWild4");
$("leave-lobby").onclick = leaveRoom;
$("leave-game").onclick = leaveRoom;

$("mute-btn").onclick = () => { Sound.toggle(); renderMuteButton(); };
renderMuteButton();

function inviteLink(code) {
  return `${location.origin}/?room=${encodeURIComponent(code)}`;
}

$("copy-code").onclick = $("copy-game-code").onclick = async () => {
  const code = state?.code || $("lobby-code").textContent;
  const text = `Join my game: ${inviteLink(code)} (room code ${code})`;
  // Phones get the share sheet; everything else gets the clipboard.
  if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ title: "Join my game", text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Invite link copied");
  } catch {
    toast(`Room code: ${code}`);
  }
};

/* Opening an invite link pre-fills the room code. */
(function openInvite() {
  const code = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (!code) return;
  $("room-code").value = code;
  $("join-name").focus({ preventScroll: true });
  $("join-name").scrollIntoView({ block: "center" });
  toast(`Room ${code}: enter your name to join`);
})();

$("opponents").addEventListener("click", e => {
  const btn = e.target.closest("[data-catch]");
  if (btn) emit("catchUno", { playerId: btn.dataset.catch });
});

function playFromButton(btn) {
  if (!btn || btn.disabled || !state?.me) return;

  const card = state.me.hand.find(c => c.id === btn.dataset.card);
  if (!card) return;

  if (card.color === "wild") {
    pendingCardId = card.id;
    openModal("color-modal", ".color-choice");
  } else if (card.value === "7" && state.settings.sevenZero && state.players.length > 2 && state.me.hand.length > 1) {
    pendingCardId = card.id;
    openSwapPicker(state);
  } else {
    emit("playCard", { cardId: card.id });
  }
}

let suppressClick = false;
$("my-hand").addEventListener("click", e => {
  if (suppressClick) return;
  playFromButton(e.target.closest("[data-card]"));
});

/* Drag a card upwards to play it (touch or mouse). Horizontal moves still scroll the hand. */
const SWIPE_DISTANCE = 70;
let drag = null;

$("my-hand").addEventListener("pointerdown", e => {
  const btn = e.target.closest("[data-card]");
  if (!btn || btn.disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
  drag = { btn, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
});

window.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;

  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy)) { drag = null; return; } // sideways: let the hand scroll
    drag.moved = true;
    drag.btn.classList.add("dragging");
    try { drag.btn.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  }

  const up = Math.min(0, dy);
  drag.btn.style.transform = `translate(${dx * 0.3}px, ${up}px)`;
  drag.btn.classList.toggle("ready", up < -SWIPE_DISTANCE);
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { btn, moved, y } = drag;
  drag = null;
  if (!moved) return;

  const played = e.type === "pointerup" && e.clientY - y < -SWIPE_DISTANCE;
  btn.classList.remove("dragging", "ready");
  btn.style.transform = "";
  suppressClick = true;                 // the browser still sends a click after a drag
  setTimeout(() => { suppressClick = false; }, 60);
  if (played) playFromButton(btn);
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

document.querySelectorAll(".color-choice").forEach(btn => {
  btn.setAttribute("aria-label", btn.dataset.color);
  btn.onclick = () => {
    if (state?.mustChooseColor) {
      emit("chooseColor", { color: btn.dataset.color });
      $("color-modal").classList.add("hidden");
      return;
    }
    if (pendingCardId) emit("playCard", { cardId: pendingCardId, color: btn.dataset.color });
    closeModals();
  };
});

$("swap-options").addEventListener("click", e => {
  const btn = e.target.closest("[data-target]");
  if (!btn) return;
  if (pendingCardId) emit("playCard", { cardId: pendingCardId, targetId: btn.dataset.target });
  closeModals();
});

["color-modal", "swap-modal"].forEach(id => {
  const card = $(id).querySelector(".modal-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  $(id).addEventListener("click", e => {
    if (e.target.id === id) closeModals();
  });
});

$("my-hand").setAttribute("role", "group");
$("my-hand").setAttribute("aria-label", "Your hand");

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModals();
});

/* ------------------------------------------------------------------ */
/* Display options: theme, card back, colour-blind symbols            */
/* ------------------------------------------------------------------ */
const DISPLAY_KEY = "tabletop.display";
const display = (() => {
  try { return { theme: "auto", back: "classic", symbols: false, ...JSON.parse(localStorage.getItem(DISPLAY_KEY)) }; }
  catch { return { theme: "auto", back: "classic", symbols: false }; }
})();

function applyDisplay() {
  const root = document.documentElement;
  root.setAttribute("data-theme", display.theme);
  root.setAttribute("data-back", display.back);
  root.classList.toggle("cb", !!display.symbols);
  document.querySelectorAll("#theme-options [data-theme]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.theme === display.theme)));
  document.querySelectorAll("#back-options [data-back]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.back === display.back)));
  $("symbols-toggle").checked = !!display.symbols;
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(display)); } catch { /* ignore */ }
}

function setPanelOpen(open) {
  $("display-panel").classList.toggle("hidden", !open);
  $("display-btn").setAttribute("aria-expanded", String(open));
}

$("display-btn").onclick = (e) => { e.stopPropagation(); setPanelOpen($("display-panel").classList.contains("hidden")); };
document.addEventListener("click", e => { if (!e.target.closest(".display-menu")) setPanelOpen(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") setPanelOpen(false); });
$("theme-options").addEventListener("click", e => {
  const b = e.target.closest("[data-theme]");
  if (b) { display.theme = b.dataset.theme; applyDisplay(); }
});
$("back-options").addEventListener("click", e => {
  const b = e.target.closest("[data-back]");
  if (b) { display.back = b.dataset.back; applyDisplay(); }
});
$("symbols-toggle").addEventListener("change", e => { display.symbols = e.target.checked; applyDisplay(); });
applyDisplay();

/* ------------------------------------------------------------------ */
/* Round start and celebration                                        */
/* ------------------------------------------------------------------ */
function isNewRound(prev, s) {
  if (s.status !== "playing") return false;
  if (!prev) return s.round === 1 && (s.log || []).length <= 2; // first screen of a fresh game, not a reload mid-game
  return prev.status !== "playing" || prev.round !== s.round;
}

/** Shuffle the deck, then deal the hand out one card at a time. */
function dealAnimation() {
  if (REDUCED_MOTION) return;
  const deck = $("draw-btn");
  const cards = [...document.querySelectorAll("#my-hand [data-card]")];
  if (!deck || !cards.length) return;

  deck.classList.add("shuffling");
  setTimeout(() => deck.classList.remove("shuffling"), 750);

  const from = restRect(deck, DECK_TILT);
  cards.forEach((el, i) => {
    const delay = 700 + i * 80;
    const total = delay + 420;
    // The real card stays invisible until the flying copy arrives.
    el.animate(
      [{ opacity: 0 }, { opacity: 0, offset: (delay + 380) / total }, { opacity: 1 }],
      { duration: total, easing: "linear" }
    );
    flyCard(deck.cloneNode(true), from, el, delay);
  });
}

/** A burst of confetti; bigger when the whole game is won. */
function confetti(big) {
  if (REDUCED_MOTION) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  const g = canvas.getContext("2d");
  const colors = ["#f15b64", "#f5c84c", "#52c58a", "#5796ed", "#b6f36b", "#ffffff"];
  const count = big ? 220 : 110;
  const pieces = Array.from({ length: count }, () => ({
    x: canvas.width * (0.2 + Math.random() * 0.6),
    y: canvas.height * 0.35,
    vx: (Math.random() - 0.5) * 12,
    vy: -6 - Math.random() * 9,
    size: 5 + Math.random() * 6,
    spin: Math.random() * Math.PI,
    vs: (Math.random() - 0.5) * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)]
  }));

  const started = performance.now();
  const length = big ? 4000 : 2600;
  (function frame(now) {
    const t = now - started;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = Math.max(0, Math.min(1, (length - t) / 700));
    for (const p of pieces) {
      p.vy += 0.28; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.spin += p.vs;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.spin);
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      g.restore();
    }
    if (t < length) requestAnimationFrame(frame);
    else canvas.remove();
  })(started);
}

/* ------------------------------------------------------------------ */
/* Chat and reactions                                                 */
/* ------------------------------------------------------------------ */
let chatOpen = false;
let unread = 0;
let chatPrimed = false;       // the first batch after joining is history, not news
let lastChatKey = "";
const seenChat = new Set();

function setChatOpen(open) {
  chatOpen = open;
  $("chat-panel").classList.toggle("hidden", !open);
  $("chat-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    unread = 0;
    renderUnread();
    const list = $("chat-list");
    list.scrollTop = list.scrollHeight;
    $("chat-input").focus();
  }
}

function renderUnread() {
  $("chat-unread").textContent = String(unread);
  $("chat-unread").classList.toggle("hidden", unread === 0);
}

/** A reaction floats up from the sender's seat (or from your own hand). */
function spawnEmote(entry) {
  const emoji = window.EMOTES?.[entry.emote];
  if (!emoji) return;

  const seat = document.querySelector(`#opponents [data-player="${CSS.escape(entry.from)}"]`);
  const rect = (seat ?? $("hand-area")).getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "emote-bubble";
  bubble.innerHTML = `<span>${emoji}</span><small>${escapeHtml(entry.name)}</small>`;
  bubble.style.left = `${rect.left + rect.width / 2}px`;
  bubble.style.top = `${Math.max(60, rect.top + (seat ? rect.height : 0))}px`;
  $("emote-layer").appendChild(bubble);
  setTimeout(() => bubble.remove(), 2600);
}

function renderChat(s) {
  const entries = s.chat || [];
  const fresh = entries.filter(e => !seenChat.has(e.id));
  entries.forEach(e => seenChat.add(e.id));

  if (!chatPrimed) {            // joined or rejoined: do not replay old reactions
    chatPrimed = true;
    renderChatList(entries);
    return;
  }

  const mine = s.me?.id ?? memberId;
  fresh.forEach(e => {
    if (e.emote) spawnEmote(e);
    if (e.from !== mine && !chatOpen) unread += 1;
  });
  if (fresh.length) renderUnread();
  renderChatList(entries);
}

function renderChatList(entries) {
  const key = `${entries.length}|${entries.at(-1)?.id ?? ""}`;
  if (key === lastChatKey) return;
  lastChatKey = key;

  const mine = state?.me?.id ?? memberId;
  const emotes = window.EMOTES || {};
  $("chat-list").innerHTML = entries.map(e =>
    `<li class="${e.from === mine ? "mine" : ""}"><b>${escapeHtml(e.name)}</b> ${
      e.emote ? `<span class="chat-emote">${emotes[e.emote] ?? ""}</span>` : escapeHtml(e.text)}</li>`).join("");
  $("chat-list").scrollTop = $("chat-list").scrollHeight;
}

$("emote-row").innerHTML = Object.entries(window.EMOTES || {}).map(([key, emoji]) =>
  `<button type="button" data-emote="${key}" aria-label="React ${key}">${emoji}</button>`).join("");
$("emote-row").addEventListener("click", e => {
  const btn = e.target.closest("[data-emote]");
  if (btn) emit("chat", { emote: btn.dataset.emote });
});
$("chat-toggle").onclick = () => setChatOpen(!chatOpen);
$("chat-form").addEventListener("submit", e => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  emit("chat", { text });
  $("chat-input").value = "";
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && chatOpen) setChatOpen(false); });

/* ------------------------------------------------------------------ */
/* Rules panel                                                         */
/* ------------------------------------------------------------------ */
function setRulesOpen(open) {
  $("rules-panel").classList.toggle("hidden", !open);
  $("rules-toggle").setAttribute("aria-expanded", String(open));
}
$("rules-toggle").onclick = () => setRulesOpen($("rules-panel").classList.contains("hidden"));
$("rules-close").onclick = () => setRulesOpen(false);
document.addEventListener("keydown", e => { if (e.key === "Escape") setRulesOpen(false); });

/* ------------------------------------------------------------------ */
/* Hall of fame (all-time wins, kept by the server)                   */
/* ------------------------------------------------------------------ */
(async function loadHallOfFame() {
  try {
    const res = await fetch("/stats");
    if (!res.ok) return;
    const { players } = await res.json();
    if (!players?.length) return;
    $("hall-list").innerHTML = players.map((p, i) => `
      <li><span class="hall-rank">${i + 1}</span><b>${escapeHtml(p.name)}</b>
        <span class="muted">${p.wins} game win${p.wins === 1 ? "" : "s"} · ${p.roundWins} round win${p.roundWins === 1 ? "" : "s"} · ${p.rounds} played</span></li>`).join("");
    $("hall").classList.remove("hidden");
  } catch { /* offline or no stats: the panel simply stays hidden */ }
})();
