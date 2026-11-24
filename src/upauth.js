// ---------------------------------------------------------------------
//  Upload password: stored in the bucket, not in KV and not as a secret.
//
//  One small JSON object at  .system/upload-auth.json :
//    { "password": "abc1234", "auto": "off", "rotatedAt": 0 }
//
//  .system/ is hidden from the file manager and is rejected by every
//  move / copy / delete / trash / share / save route (see isInternal in
//  util.js), so the file cannot be touched from the UI or the public host.
// ---------------------------------------------------------------------
import { HttpError, logEvent } from "./util.js";
import { sys } from "./storage/index.js";

const AUTH_KEY = ".system/upload-auth.json";
const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
//  Password generation: exactly 7 characters of a-z, A-Z, 0-9
// ---------------------------------------------------------------------
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 62 characters
const PW_LEN = 7;
// 248 is the largest multiple of 62 that fits in a byte (4 x 62). Bytes at or
// above it would make the first 8 letters slightly more likely, so they are
// thrown away and a fresh byte is drawn instead (rejection sampling).
const BIAS_LIMIT = 248;

function generatePassword() {
  let out = "";
  const buf = new Uint8Array(16);
  while (out.length < PW_LEN) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < PW_LEN; i++) {
      if (buf[i] >= BIAS_LIMIT) continue; // biased byte: draw again
      out += ALPHABET[buf[i] % 62];
    }
  }
  return out;
}

// Generated passwords are 7 letters and numbers; one typed in by hand may be 7 to 24 of any
// visible ASCII character (letters, numbers and symbols like !@#$%). No spaces and no accented
// letters or emoji: the password travels in an HTTP header ("Authorization: Bearer ..."),
// which cannot carry those reliably.
const validPassword = (p) => typeof p === "string" && /^[\x21-\x7E]{7,24}$/.test(p);

// Workers have no crypto.timingSafeEqual, so compare by hand without an early exit.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------
//  Reading and writing the settings object
// ---------------------------------------------------------------------
const clean = (o) => ({
  password: o.password,
  auto: o.auto === "on" ? "on" : "off",
  rotatedAt: Number.isFinite(Number(o.rotatedAt)) ? Number(o.rotatedAt) : 0,
});

async function writeAuth(c, a) {
  await sys(c).write(AUTH_KEY, JSON.stringify(clean(a)), "application/json");
  return clean(a);
}

// First use: make a password, leave auto-rotation off, stamp the time.
async function createAuth(c, why) {
  const a = { password: generatePassword(), auto: "off", rotatedAt: Date.now() };
  await writeAuth(c, a);
  logEvent("password.generated", { by: why || "first-use" });
  logEvent("password.saved", { by: why || "first-use" });
  return a;
}

async function readAuth(c) {
  const text = await sys(c).read(AUTH_KEY);
  if (text === null) return createAuth(c, "first-use");
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o) && validPassword(o.password)) return clean(o);
  } catch (e) { /* unreadable: fall through and start again */ }
  return createAuth(c, "repair"); // the file was damaged or hand-edited into something unusable
}

// Save a password and/or the auto-rotate flag. Only the given fields change.
async function saveAuth(c, { password, auto }) {
  const cur = await readAuth(c);
  const next = { password: cur.password, auto: cur.auto, rotatedAt: cur.rotatedAt };
  if (password !== undefined) {
    if (!validPassword(password)) throw new HttpError(400, "The password must be 7 to 24 characters: letters, numbers and symbols, without spaces.");
    if (password !== cur.password) { next.password = password; next.rotatedAt = Date.now(); }
  }
  if (auto !== undefined) {
    if (auto !== "on" && auto !== "off") throw new HttpError(400, "Auto-rotate must be on or off.");
    // Turning it on starts the 6-day clock from now, so it never rotates straight away.
    if (auto === "on" && cur.auto !== "on") next.rotatedAt = Date.now();
    next.auto = auto;
  }
  const saved = await writeAuth(c, next);
  if (password !== undefined) logEvent("password.saved", { by: "settings" });
  if (auto !== undefined && auto !== cur.auto) logEvent("auto.toggled", { auto: saved.auto });
  return saved;
}

// ---------------------------------------------------------------------
//  Scheduled rotation (cron). Rotation happens on the first run at or
//  after the 6-day mark, so it can be up to 24 hours late.
// ---------------------------------------------------------------------
async function rotateIfDue(c) {
  const a = await readAuth(c);
  if (a.auto !== "on") {
    logEvent("cron.run", { decision: "skipped", reason: "auto-rotate is off" });
    return { rotated: false };
  }
  const due = a.rotatedAt + SIX_DAYS;
  if (Date.now() < due) {
    logEvent("cron.run", { decision: "skipped", reason: "not due yet", due: new Date(due).toISOString() });
    return { rotated: false };
  }
  const next = { password: generatePassword(), auto: "on", rotatedAt: Date.now() };
  await writeAuth(c, next);
  logEvent("password.generated", { by: "cron" });
  logEvent("password.saved", { by: "cron" });
  logEvent("rotation.performed", { rotatedAt: new Date(next.rotatedAt).toISOString() });
  logEvent("cron.run", { decision: "rotated" });
  return { rotated: true };
}

export { AUTH_KEY, SIX_DAYS, generatePassword, validPassword, safeEqual, readAuth, saveAuth, rotateIfDue };
