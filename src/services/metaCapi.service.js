import crypto from "crypto";

// =========================================
// META CONVERSIONS API (server-side events)
// Mirrors the browser Pixel events fired through GTM. Meta de-duplicates
// the two when event_name + event_id match.
// Never send PHI — only hashed email / user id, plan value and currency.
// No-op when META_PIXEL_ID / META_CAPI_TOKEN are not configured.
// =========================================

const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");

// Client IP / user agent for match quality (stored on Stripe metadata at
// checkout, read straight from the request elsewhere).
export function getClientInfo(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return {
    ip: (forwarded ? forwarded.split(",")[0] : req.ip || "")
      .trim()
      .replace(/^::ffff:/, ""), // IPv4-mapped IPv6 → plain IPv4
    userAgent: (req.headers["user-agent"] || "").slice(0, 500),
  };
}

export async function sendMetaEvent({
  eventName,
  eventId,
  email,
  externalId,
  fbp,
  fbc,
  ip,
  userAgent,
  sourceUrl,
  value,
  currency = "USD",
}) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return;

  const user_data = {};
  if (email) user_data.em = [sha256(email)];
  if (externalId) user_data.external_id = [sha256(externalId)];
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;
  if (ip) user_data.client_ip_address = ip;
  if (userAgent) user_data.client_user_agent = userAgent;

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    event_source_url: sourceUrl,
    user_data,
  };
  if (eventId) event.event_id = String(eventId);
  if (value !== undefined) event.custom_data = { value, currency };

  const body = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE)
    body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const version = process.env.META_GRAPH_VERSION || "v23.0";

  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const json = await res.json();
    if (!res.ok) console.error("❌ Meta CAPI error:", json?.error || json);
    else console.log(`📣 Meta CAPI ${eventName} sent (id ${eventId})`);
  } catch (error) {
    // Tracking must never break payments or sign-up
    console.error("❌ Meta CAPI request failed:", error.message);
  }
}
