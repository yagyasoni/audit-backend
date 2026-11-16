

import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { sendMetaEvent } from "../services/metaCapi.service.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =========================================
// PLAN MAP — 3 fixed tiers, no add-ons
// base        → $99  /mo → inventory_reports_access
// professional→ $249 /mo → inventory_reports_access + inventory_view_access
// full_access → $399 /mo → all access
// =========================================

const PRICE_MAP = {
  base: process.env.STRIPE_BASE_PRICE_ID,
  professional: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
  full_access: process.env.STRIPE_FULL_ACCESS_PRICE_ID,
};

router.post(
  "/",
  express.raw({ type: "application/json" }),

  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.sendStatus(400);
    }

    // Each Stripe event is handled once. The event is "claimed" first; a
    // second delivery of the same event is answered OK without doing the
    // work again. If handling FAILS, the claim is given back (see the catch
    // below) so that Stripe's retry is processed and not skipped.
    const claimed = await claimEvent(event.id);
    if (claimed === false) return res.sendStatus(200);

    try {
      switch (event.type) {
        // =====================================
        // SUBSCRIPTION ACTIVE / RENEWED / UPDATED
        // Covers: new checkout, trial start, renewals, upgrades
        // =====================================

        case "checkout.session.completed":
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "invoice.paid": {
          let subscription;

          if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            if (!session.subscription) break;

            subscription = await stripe.subscriptions.retrieve(
              session.subscription,
            );

            // Fix missing metadata (Stripe sometimes doesn't forward it)
            if (!subscription.metadata?.userId && session.metadata?.userId) {
              await stripe.subscriptions.update(subscription.id, {
                metadata: { userId: session.metadata.userId },
              });
              subscription = await stripe.subscriptions.retrieve(
                subscription.id,
              );
            }
          } else if (event.type === "invoice.paid") {
            const invoice = event.data.object;
            // M30: subscription id may be on .subscription or .parent.subscription_details.subscription
            const paidSubId =
              invoice.subscription ||
              invoice.parent?.subscription_details?.subscription;
            if (!paidSubId) break;
            subscription = await stripe.subscriptions.retrieve(paidSubId);
          } else {
            subscription = await stripe.subscriptions.retrieve(
              event.data.object.id,
            );
          }

          console.log("=================================");
          console.log("EVENT   :", event.type);
          console.log("SUB ID  :", subscription.id);
          console.log("STATUS  :", subscription.status);
          console.log("METADATA:", subscription.metadata);
          console.log("=================================");

          // A subscription that has ended is handled like a cancel, whatever
          // event reports it. This also stops a late event for an OLD, ended
          // subscription from overwriting a newer one the customer bought.
          if (hasEnded(subscription.status)) {
            await revokeSubscription(subscription.id);
            break;
          }

          await syncSubscription(subscription);

          // Record the trial-code redemption (idempotent).
          await finalizeTrialRedemption(subscription);

          // New subscriber only — renewals/upgrades are not ad conversions.
          // event_id = session.id, so Stripe retries and the browser Pixel
          // purchase are de-duplicated by Meta. Skips unpaid (async) payments.
          if (
            event.type === "checkout.session.completed" &&
            event.data.object.payment_status !== "unpaid"
          ) {
            const session = event.data.object;
            const isTrial = subscription.status === "trialing";
            await sendMetaEvent({
              eventName: isTrial ? "StartTrial" : "Subscribe",
              eventId: session.id,
              email: session.customer_details?.email,
              externalId: session.metadata?.userId,
              fbp: session.metadata?.fbp,
              fbc: session.metadata?.fbc,
              ip: session.metadata?.ip,
              userAgent: session.metadata?.ua,
              sourceUrl: "https://www.auditprorx.com/Mainpage",
              value: isTrial ? 0 : (session.amount_total || 0) / 100,
              currency: (session.currency || "usd").toUpperCase(),
            });
          }
          break;
        }

        // =====================================
        // TRIAL ENDING SOON (fires 3 days before trial_end)
        // =====================================

        case "customer.subscription.trial_will_end": {
          const subscription = event.data.object;
          console.log(`⏰ Trial ending soon — sub: ${subscription.id}`);
          // TODO: send reminder email
          break;
        }

        // =====================================
        // PAYMENT FAILED → no access until it is paid
        // Stripe's own status decides: "past_due" / "unpaid" lose access
        // here, and get it back through invoice.paid when the payment
        // goes through. The plan label is kept so the customer still sees
        // which plan is waiting for payment.
        // =====================================

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          // M30: subscription id may be on .subscription or .parent.subscription_details.subscription
          const failedSubId =
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription;
          if (!failedSubId) break;

          const subscription = await stripe.subscriptions.retrieve(
            failedSubId,
          );

          if (hasEnded(subscription.status)) {
            await revokeSubscription(subscription.id);
            break;
          }

          // Stripe still counts it as paid (for example a retry has already
          // succeeded): nothing to take away.
          if (hasPaidAccess(subscription.status)) break;

          // (access an admin granted by hand is not paid through Stripe and
          // stays on: see ADMIN-GRANTED ACCESS below)
          await pool.query(
            `UPDATE subscriptions
             SET status=$2,
                 inventory_reports_access = (admin_override AND inventory_reports_access),
                 inventory_view_access    = (admin_override AND inventory_view_access),
                 drug_lookup_access       = (admin_override AND drug_lookup_access),
                 leads_access             = (admin_override AND leads_access),
                 full_access              = (admin_override AND full_access),
                 updated_at=NOW()
             WHERE stripe_subscription_id = $1`,
            [subscription.id, subscription.status],
          );

          console.log(
            `⚠️  Payment failed — sub: ${subscription.id} (${subscription.status}), access paused`,
          );
          break;
        }

        // =====================================
        // SUBSCRIPTION DELETED → revoke all access
        // NOTE: trial_code is intentionally KEPT, so the user can't get a
        // second free trial after canceling.
        // =====================================

        case "customer.subscription.deleted": {
          const subscription = event.data.object;

          await revokeSubscription(subscription.id);
          break;
        }

        default:
          break;
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("❌ Webhook error:", error);
      // Not handled: give the claim back so the retry is processed.
      if (claimed) await releaseEvent(event.id);
      return res.sendStatus(500);
    }
  },
);

// =========================================
// HANDLE EACH EVENT ONCE
// processed_webhook_events holds the ids of events already handled
// (migration 20261114_processed_webhook_events.sql).
//   claimEvent   → true  : first time, go on and handle it
//                  false : already handled, skip
//                  null  : the table does not exist yet (migration not run);
//                          the event is handled without this protection
//   releaseEvent → forget a claim after a failure, so the retry runs
// =========================================

let warnedMissingEventsTable = false;

async function claimEvent(eventId) {
  if (!eventId) return null;
  try {
    const result = await pool.query(
      `INSERT INTO processed_webhook_events (stripe_event_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING stripe_event_id`,
      [eventId],
    );
    return result.rowCount === 1;
  } catch (error) {
    // 42P01 = table does not exist
    if (error?.code === "42P01") {
      if (!warnedMissingEventsTable) {
        warnedMissingEventsTable = true;
        console.warn(
          "[webhook] Table processed_webhook_events is missing. Events are " +
            "still handled, but repeats are not filtered. Run the migration.",
        );
      }
      return null;
    }
    // Any other database failure: answer Stripe with an error so it retries.
    console.error("❌ Webhook claim error:", error);
    throw error;
  }
}

async function releaseEvent(eventId) {
  try {
    await pool.query(
      `DELETE FROM processed_webhook_events WHERE stripe_event_id = $1`,
      [eventId],
    );
  } catch (error) {
    console.error("❌ Webhook release error:", error);
  }
}

// =========================================
// SUBSCRIPTION STATES (Stripe's own words)
//   paid access : "active" or "trialing" only. "past_due", "unpaid",
//                 "incomplete" and "paused" mean nobody is paying right now.
//   ended       : "canceled" / "incomplete_expired" can never bill again.
// =========================================

const PAID_STATES = ["active", "trialing"];
const ENDED_STATES = ["canceled", "incomplete_expired"];

const hasPaidAccess = (status) => PAID_STATES.includes(status);
const hasEnded = (status) => ENDED_STATES.includes(status);

// =========================================
// ADMIN-GRANTED ACCESS (admin_override)
// The admin dashboard can switch access on for a pharmacy by hand. Such a
// row has admin_override = true. Rules used in this file:
//   - A Stripe event still records the subscription (ids, status, plan), so
//     a pharmacy with a manual grant can also buy, change and cancel a plan.
//   - A Stripe event never switches OFF access the admin switched on: each
//     flag becomes "plan gives it OR admin had it on".
//   - Once the paid plan covers everything that is on, the row is an
//     ordinary paid subscription again (admin_override goes back to false),
//     so later downgrades and cancels behave normally.
// SQL: true when the row has a manual grant with at least one flag on.
// =========================================

const ADMIN_GRANT_HOLDS = `(admin_override AND (
  inventory_reports_access OR inventory_view_access OR drug_lookup_access
  OR leads_access OR full_access))`;

// =========================================
// REVOKE AN ENDED SUBSCRIPTION
// Removes all access AND forgets the subscription id, so the customer can
// subscribe again (checkout refuses while a subscription id is saved).
// The Stripe customer id is kept, so a new subscription reuses the same
// customer. Matching on the subscription id means an event for an old
// subscription never touches a newer one.
// NOTE: trial_code is intentionally KEPT, so the user can't get a second
// free trial after canceling.
// =========================================

async function revokeSubscription(stripeSubscriptionId) {
  // Access that an admin granted by hand (admin_override, see ADMIN-GRANTED
  // ACCESS below) is not paid for through Stripe, so the end of the Stripe
  // subscription does not take it away.
  await pool.query(
    `UPDATE subscriptions
     SET status = CASE WHEN ${ADMIN_GRANT_HOLDS} THEN 'active' ELSE 'canceled' END,
         subscription_type = CASE
           WHEN admin_override AND full_access              THEN 'full_access'
           WHEN admin_override AND inventory_view_access    THEN 'professional'
           WHEN admin_override AND inventory_reports_access THEN 'base'
           ELSE 'none'
         END,
         stripe_subscription_id=NULL,
         inventory_reports_access = (admin_override AND inventory_reports_access),
         inventory_view_access    = (admin_override AND inventory_view_access),
         drug_lookup_access       = (admin_override AND drug_lookup_access),
         leads_access             = (admin_override AND leads_access),
         full_access              = (admin_override AND full_access),
         active_price_ids=ARRAY[]::TEXT[], cancel_at_period_end=false,
         trial_end=NULL, grace_period_end=NULL, pending_plan=NULL,
         updated_at=NOW()
     WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId],
  );

  console.log(`🚫 Subscription canceled — sub: ${stripeSubscriptionId}`);
}

// =========================================
// FINALIZE TRIAL CODE REDEMPTION
// Idempotent WITHOUT a redemptions table: we flip subscriptions.trial_code
// from NULL → code, and only count the redemption on the delivery that
// actually changes it (Postgres row-locking makes this race-safe).
// =========================================

async function finalizeTrialRedemption(subscription) {
  try {
    const trialCode = subscription.metadata?.trialCode;
    if (!trialCode) return; // no code on this subscription

    // One free trial per pharmacy: a pharmacy that already has a DIFFERENT
    // trial code on record does not get a second code counted. (There is one
    // subscriptions row per user, and trial_code is kept after a cancel.)
    const alreadyUsed = await pool.query(
      `SELECT 1 FROM subscriptions
        WHERE stripe_subscription_id = $1
          AND trial_code IS NOT NULL
          AND trial_code <> $2`,
      [subscription.id, trialCode],
    );
    if (alreadyUsed.rows.length) {
      console.log(`⚠️  Trial code ${trialCode} skipped — user already redeemed a trial`);
      return;
    }

    const updated = await pool.query(
      `UPDATE subscriptions
          SET trial_code = $1
        WHERE stripe_subscription_id = $2
          AND trial_code IS DISTINCT FROM $1
        RETURNING id`,
      [trialCode, subscription.id],
    );

    // Only the FIRST delivery actually changes the row → attempt atomic increment.
    // L25: use a conditional UPDATE so two concurrent completions can never
    // both push times_redeemed past max_redemptions.
    if (updated.rows.length) {
      const claimed = await pool.query(
        `UPDATE trial_codes
            SET times_redeemed = times_redeemed + 1
          WHERE code = $1
            AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
          RETURNING id`,
        [trialCode],
      );
      if (claimed.rows.length) {
        console.log(`🎟️  Trial code ${trialCode} redeemed (sub ${subscription.id})`);
      } else {
        console.warn(`⚠️  Trial code ${trialCode} limit already reached at webhook — trial granted by Stripe but not counted`);
      }
    }
  } catch (error) {
    console.error("❌ finalizeTrialRedemption error:", error);
    if (error?.detail) console.error("DETAIL:", error.detail);
  }
}

// =========================================
// SYNC SUBSCRIPTION TO DATABASE
// Resolves access flags from the active price ID. Clears pending_plan
// once a scheduled downgrade has taken effect.
// =========================================

async function syncSubscription(subscription) {
  try {
    const userId =
      subscription.metadata?.userId ||
      subscription.metadata?.userid ||
      subscription.metadata?.user_id;

    if (!userId) {
      console.log("❌ Missing userId metadata — skipping sync");
      return;
    }

    const activePriceIds = subscription.items.data.map((item) => item.price.id);
    console.log("USER ID   :", userId);
    console.log("PRICE IDS :", activePriceIds);

    let inventory_reports_access = false;
    let inventory_view_access = false;
    let drug_lookup_access = false;
    let leads_access = false;
    let full_access = false;

    if (activePriceIds.includes(PRICE_MAP.full_access)) {
      full_access = true;
      inventory_reports_access = true;
      inventory_view_access = true;
      drug_lookup_access = true;
      leads_access = true;
    } else if (activePriceIds.includes(PRICE_MAP.professional)) {
      inventory_reports_access = true;
      inventory_view_access = true;
    } else if (activePriceIds.includes(PRICE_MAP.base)) {
      inventory_reports_access = true;
    }

    let subscriptionType = "none";
    if (full_access) subscriptionType = "full_access";
    else if (inventory_view_access) subscriptionType = "professional";
    else if (inventory_reports_access) subscriptionType = "base";

    // Access is given only while Stripe says the subscription is paid
    // (active or in trial). An unpaid subscription keeps its plan label
    // above, but every access flag is off until the payment goes through.
    if (!hasPaidAccess(subscription.status)) {
      inventory_reports_access = false;
      inventory_view_access = false;
      drug_lookup_access = false;
      leads_access = false;
      full_access = false;
    }

    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000)
      : null;

    const periodEnd =
      subscription.current_period_end ||
      subscription.items?.data?.[0]?.current_period_end ||
      null;

    console.log("SYNCING TO DATABASE — plan:", subscriptionType);

    await pool.query(
      `INSERT INTO subscriptions (
         user_id, stripe_customer_id, stripe_subscription_id, status,
         current_period_end, cancel_at_period_end, subscription_type,
         inventory_reports_access, inventory_view_access, drug_lookup_access,
         leads_access, full_access, active_price_ids, trial_end,
         grace_period_end, pending_plan, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         NULL, NULL, NOW()
       )
       ON CONFLICT (user_id) DO UPDATE SET
         stripe_customer_id       = EXCLUDED.stripe_customer_id,
         stripe_subscription_id   = EXCLUDED.stripe_subscription_id,
         status                   = EXCLUDED.status,
         current_period_end       = EXCLUDED.current_period_end,
         cancel_at_period_end     = EXCLUDED.cancel_at_period_end,
         subscription_type        = EXCLUDED.subscription_type,
         -- Access the admin switched on by hand is never switched off by a
         -- Stripe event (see ADMIN-GRANTED ACCESS above). "subscriptions.x"
         -- is the value before this update.
         inventory_reports_access = EXCLUDED.inventory_reports_access
           OR (subscriptions.admin_override AND subscriptions.inventory_reports_access),
         inventory_view_access    = EXCLUDED.inventory_view_access
           OR (subscriptions.admin_override AND subscriptions.inventory_view_access),
         drug_lookup_access       = EXCLUDED.drug_lookup_access
           OR (subscriptions.admin_override AND subscriptions.drug_lookup_access),
         leads_access             = EXCLUDED.leads_access
           OR (subscriptions.admin_override AND subscriptions.leads_access),
         full_access              = EXCLUDED.full_access
           OR (subscriptions.admin_override AND subscriptions.full_access),
         -- The manual grant stays marked only while it gives something the
         -- paid plan does not.
         admin_override = subscriptions.admin_override AND (
              (subscriptions.inventory_reports_access AND NOT EXCLUDED.inventory_reports_access)
           OR (subscriptions.inventory_view_access    AND NOT EXCLUDED.inventory_view_access)
           OR (subscriptions.drug_lookup_access       AND NOT EXCLUDED.drug_lookup_access)
           OR (subscriptions.leads_access             AND NOT EXCLUDED.leads_access)
           OR (subscriptions.full_access              AND NOT EXCLUDED.full_access)
         ),
         active_price_ids         = EXCLUDED.active_price_ids,
         trial_end                = EXCLUDED.trial_end,
         pending_plan =
           CASE
             WHEN subscriptions.pending_plan IS NOT NULL
              AND EXCLUDED.subscription_type = subscriptions.pending_plan
             THEN NULL ELSE subscriptions.pending_plan
           END,
         grace_period_end =
           CASE
             WHEN EXCLUDED.cancel_at_period_end = false
             THEN NULL ELSE subscriptions.grace_period_end
           END,
         updated_at = NOW()`,
      [
        userId,
        subscription.customer,
        subscription.id,
        subscription.status,
        periodEnd ? new Date(periodEnd * 1000) : null,
        subscription.cancel_at_period_end,
        subscriptionType,
        inventory_reports_access,
        inventory_view_access,
        drug_lookup_access,
        leads_access,
        full_access,
        activePriceIds,
        trialEnd,
      ],
    );

    console.log("✅ Subscription synced — type:", subscriptionType);
  } catch (error) {
    console.error("❌ syncSubscription error:", error);
    if (error?.detail) console.error("DETAIL:", error.detail);
    if (error?.constraint) console.error("CONSTRAINT:", error.constraint);
    // Pass the failure on. The webhook then answers Stripe with an error,
    // and Stripe sends the event again later. Swallowing it here made the
    // webhook answer "OK" while nothing was saved: the customer was charged
    // and never got access.
    throw error;
  }
}

export default router;
