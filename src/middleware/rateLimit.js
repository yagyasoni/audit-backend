// ─────────────────────────────────────────────────────────────
// FILE: src/middleware/rateLimit.js
//
// Limits on how often login, sign-up and forgot-password can be called.
// Two kinds of limit:
//
//   per email             the same account, from anywhere
//   per internet address  the same visitor, across many accounts
//
// The email code routes (check code, resend code) are limited separately, per
// code and per email, in services/emailOtp.service.js.
//
// Counters live in this process's memory: they reset when the server
// restarts and are not shared between processes.
//
// "Internet address" is req.ip. app.js sets `trust proxy` to "loopback", so
// behind nginx req.ip is the visitor's address from X-Forwarded-For. If nginx
// does not send that header, every visitor arrives as nginx's own address and
// would share one counter. The per-address limits are skipped in that case
// (see sharedAddress) rather than locking all visitors out together.
// ─────────────────────────────────────────────────────────────

import net from "node:net";
import { rateLimit } from "express-rate-limit";

const MINUTE = 60 * 1000;

// ── Reply when a limit is passed ─────────────────────────────
// 429 with the wait in the message, in `retryAfter` (seconds) and in the
// Retry-After header.
function tooManyAttempts(req, res, _next, options) {
  const resetTime = req.rateLimit?.resetTime;
  const waitMs = resetTime
    ? resetTime.getTime() - Date.now()
    : options.windowMs;
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const minutes = Math.ceil(seconds / 60);

  res.set("Retry-After", String(seconds));
  return res.status(429).json({
    code: "RATE_LIMITED",
    message: `Too many attempts. Please try again in ${minutes} ${
      minutes === 1 ? "minute" : "minutes"
    }.`,
    retryAfter: seconds,
  });
}

// ── Per internet address ─────────────────────────────────────
// Addresses that can only be this machine or a proxy, never a visitor from
// the internet: loopback, private ranges, link-local.
const internalAddresses = new net.BlockList();
internalAddresses.addSubnet("127.0.0.0", 8, "ipv4");
internalAddresses.addSubnet("10.0.0.0", 8, "ipv4");
internalAddresses.addSubnet("172.16.0.0", 12, "ipv4");
internalAddresses.addSubnet("192.168.0.0", 16, "ipv4");
internalAddresses.addSubnet("169.254.0.0", 16, "ipv4");
internalAddresses.addAddress("::1", "ipv6");
internalAddresses.addSubnet("fc00::", 7, "ipv6");
internalAddresses.addSubnet("fe80::", 10, "ipv6");

function isInternalAddress(ip) {
  if (!ip) return true;
  const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(address)) return internalAddresses.check(address, "ipv4");
  if (net.isIPv6(address)) return internalAddresses.check(address, "ipv6");
  return true;
}

let warnedSharedAddress = false;

// True when the request carries no visitor address of its own, so counting
// it would count every visitor together.
function sharedAddress(req) {
  if (!isInternalAddress(req.ip)) return false;

  if (!warnedSharedAddress) {
    warnedSharedAddress = true;
    console.warn(
      `[rate-limit] Requests are arriving from an internal address (${req.ip}) ` +
        "with no visitor address attached, so the per-address limits are OFF. " +
        "This is expected on a developer machine. On the server it means nginx " +
        "is not sending the X-Forwarded-For header.",
    );
  }
  return true;
}

const perAddress = ({ minutes, limit }) =>
  rateLimit({
    windowMs: minutes * MINUTE,
    limit,
    skip: sharedAddress,
    handler: tooManyAttempts,
    standardHeaders: false,
    legacyHeaders: false,
  });

// ── Per email ────────────────────────────────────────────────
// The email in the request body, trimmed and lower-cased so "A@x.com" and
// "a@x.com " count as one. Empty when there is none (the route then answers
// with its own error and only the per-address limit applies).
function emailOf(req) {
  const email = req.body?.email;
  if (typeof email !== "string") return "";
  const key = email.trim().toLowerCase();
  return key.length > 0 && key.length <= 254 ? key : "";
}

const perEmail = ({ minutes, limit }) =>
  rateLimit({
    windowMs: minutes * MINUTE,
    limit,
    keyGenerator: emailOf,
    skip: (req) => !emailOf(req),
    handler: tooManyAttempts,
    standardHeaders: false,
    legacyHeaders: false,
  });

// ── The limits ───────────────────────────────────────────────
// Every call counts, whether it succeeds or not.

// Login: 10 tries in 15 minutes for one email, 20 in 15 minutes from one address.
export const loginLimits = [
  perAddress({ minutes: 15, limit: 20 }),
  perEmail({ minutes: 15, limit: 10 }),
];

// Sign-up: 5 per hour from one address.
export const signupLimits = [perAddress({ minutes: 60, limit: 5 })];

// Forgot password: 3 emails per hour for one email, 5 per hour from one address.
export const forgotPasswordLimits = [
  perAddress({ minutes: 60, limit: 5 }),
  perEmail({ minutes: 60, limit: 3 }),
];
