"use strict";

const { uid } = require("./deck");

/** Quick reactions. The server only accepts these keys, the browser shows the emoji. */
const EMOTES = {
  laugh: "😂", cry: "😭", fire: "🔥", skull: "💀", clap: "👏", angry: "😡", eyes: "👀", gg: "🤝"
};

const MAX_CHAT_LENGTH = 120;
const MAX_CHAT_KEPT = 50;

/** Plain text only: no control characters, no runs of spaces, limited length. */
function cleanChatText(text) {
  return String(text ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ") // control and invisible formatting characters
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

/** Add a message (or reaction) from a room member. Returns the stored entry. */
function addChat(room, member, { text, emote } = {}) {
  let entry;
  if (emote !== undefined) {
    if (!Object.hasOwn(EMOTES, emote)) throw new Error("Unknown reaction.");
    entry = { id: uid(), from: member.id, name: member.name, emote };
  } else {
    const clean = cleanChatText(text);
    if (!clean) throw new Error("Write something first.");
    entry = { id: uid(), from: member.id, name: member.name, text: clean };
  }
  room.chat.push(entry);
  if (room.chat.length > MAX_CHAT_KEPT) room.chat.splice(0, room.chat.length - MAX_CHAT_KEPT);
  return entry;
}

module.exports = { EMOTES, MAX_CHAT_LENGTH, MAX_CHAT_KEPT, cleanChatText, addChat };
