

import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =========================================
// PLAN MAP — 3 fixed tiers, no add-ons
// base        → $99  /mo → inventory_reports_access
// professional→ $249 /mo → inventory_reports_access + inventory_view_access
// full_access → $499 /mo → all access
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
            if (!invoice.subscription) break;
            subscription = await stripe.subscriptions.retrieve(
              invoice.subscription,
            );
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

          await syncSubscription(subscription);

          // Record the trial-code redemption (idempotent).
          await finalizeTrialRedemption(subscription);
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
        // PAYMENT FAILED → mark past_due
        // =====================================

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          if (!invoice.subscription) break;

          await pool.query(
            `UPDATE subscriptions
             SET status='past_due', updated_at=NOW()
             WHERE stripe_subscription_id = $1`,
            [invoice.subscription],
          );

          console.log(`⚠️  Payment failed — sub: ${invoice.subscription}`);
          break;
        }

        // =====================================
        // SUBSCRIPTION DELETED → revoke all access
        // NOTE: trial_code is intentionally KEPT, so the user can't get a
        // second free trial after canceling.
        // =====================================

        case "customer.subscription.deleted": {
          const subscription = event.data.object;

          await pool.query(
            `UPDATE subscriptions
             SET status='canceled', subscription_type='none',
                 inventory_reports_access=false, inventory_view_access=false,
                 drug_lookup_access=false, leads_access=false, full_access=false,
                 active_price_ids=ARRAY[]::TEXT[], cancel_at_period_end=false,
                 trial_end=NULL, grace_period_end=NULL, pending_plan=NULL,
                 updated_at=NOW()
             WHERE stripe_subscription_id = $1`,
            [subscription.id],
          );

          console.log(`🚫 Subscription canceled — sub: ${subscription.id}`);
          break;
        }

        default:
          break;
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("❌ Webhook error:", error);
      return res.sendStatus(500);
    }
  },
);

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

    const updated = await pool.query(
      `UPDATE subscriptions
          SET trial_code = $1
        WHERE stripe_subscription_id = $2
          AND trial_code IS DISTINCT FROM $1
        RETURNING id`,
      [trialCode, subscription.id],
    );

    // Only the FIRST delivery actually changes the row → count once
    if (updated.rows.length) {
      await pool.query(
        `UPDATE trial_codes SET times_redeemed = times_redeemed + 1 WHERE code = $1`,
        [trialCode],
      );
      console.log(
        `🎟️  Trial code ${trialCode} redeemed (sub ${subscription.id})`,
      );
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
         inventory_reports_access = EXCLUDED.inventory_reports_access,
         inventory_view_access    = EXCLUDED.inventory_view_access,
         drug_lookup_access       = EXCLUDED.drug_lookup_access,
         leads_access             = EXCLUDED.leads_access,
         full_access              = EXCLUDED.full_access,
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
  }
}

export default router;
