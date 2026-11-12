/**
 * GA4 Measurement Protocol — server-side event firing.
 *
 * Used for events where the browser pixel can't be trusted to fire
 * (OTP verification completes in an API call, not a page load).
 *
 * Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4
 *
 * Required env vars:
 *   GA4_MEASUREMENT_ID   — e.g. G-RWMRW48SE0
 *   GA4_API_SECRET       — from GA4 Admin → Data Streams → Measurement Protocol API secrets
 */

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

/**
 * Send one event to GA4 via Measurement Protocol.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * @param {object} opts
 * @param {string} opts.eventName       - GA4 event name, e.g. "qualify_lead"
 * @param {string} [opts.clientId]      - GA4 client_id from _ga cookie (preferred)
 * @param {string} [opts.userId]        - internal user id (passed as user_id)
 * @param {object} [opts.params]        - extra event params
 */
export async function sendGA4Event({ eventName, clientId, userId, params = {} }) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) {
    console.warn("[ga4mp] GA4_MEASUREMENT_ID or GA4_API_SECRET not set — skipping");
    return;
  }

  // GA4 requires a client_id; fall back to userId if _ga cookie is unavailable
  const cid = clientId || `server.${userId || "unknown"}`;

  const body = {
    client_id: cid,
    ...(userId ? { user_id: String(userId) } : {}),
    events: [
      {
        name: eventName,
        params: {
          engagement_time_msec: 1,
          ...params,
        },
      },
    ],
  };

  const url = `${GA4_ENDPOINT}?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  // Non-blocking — tracking must never slow down or break the actual request
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => {
      if (!r.ok) r.text().then((t) => console.warn(`[ga4mp] ${eventName} HTTP ${r.status}:`, t));
    })
    .catch((err) => console.warn("[ga4mp] fetch error:", err?.message || err));
}
