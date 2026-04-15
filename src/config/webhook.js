
import express from "express";
import Stripe from "stripe";
import { pool } from "../config/db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    console.log("✅ Webhook received:", event.type);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          console.log(
            "🔍 SESSION DUMP:",
            JSON.stringify(
              {
                id: session.id,
                customer: session.customer,
                subscription: session.subscription,
                status: session.status,
              },
              null,
              2,
            ),
          );

          if (!session.subscription) {
            console.log(
              "⚠️ No subscription on session yet — trial race. subscription.created will handle it.",
            );
            break;
          }

          // Fetch fresh subscription
          const freshSub = await stripe.subscriptions.retrieve(
            session.subscription,
          );
          console.log(
            "🔍 FRESH SUB FROM checkout.session.completed:",
            JSON.stringify(
              {
                id: freshSub.id,
                status: freshSub.status,
                trial_end: freshSub.trial_end,
                current_period_end: freshSub.current_period_end,
                customer: freshSub.customer,
              },
              null,
              2,
            ),
          );

          await upsertSubscription(freshSub, "customer");
          break;
        }

        case "customer.subscription.created": {
          const sub = event.data.object;

          // 🔍 LOG RAW PAYLOAD FIRST
          console.log(
            "🔍 RAW subscription.created PAYLOAD:",
            JSON.stringify(
              {
                id: sub.id,
                status: sub.status,
                trial_end: sub.trial_end,
                current_period_end: sub.current_period_end,
                customer: sub.customer,
              },
              null,
              2,
            ),
          );

          // Fetch fresh to double-check
          const freshSub = await stripe.subscriptions.retrieve(sub.id);
          console.log(
            "🔍 FRESH SUB RETRIEVE:",
            JSON.stringify(
              {
                id: freshSub.id,
                status: freshSub.status,
                trial_end: freshSub.trial_end,
                current_period_end: freshSub.current_period_end,
                customer: freshSub.customer,
              },
              null,
              2,
            ),
          );

          const dbCheck = await pool.query(
            `SELECT user_id, stripe_customer_id FROM subscriptions WHERE stripe_customer_id = $1`,
            [freshSub.customer],
          );
          console.log("🔍 DB ROW FOUND:", dbCheck.rows);

          if (dbCheck.rows.length === 0) {
            console.log(
              "❌ No DB row — cannot update. Customer ID:",
              freshSub.customer,
            );
            break;
          }

          await upsertSubscription(freshSub, "customer");
          console.log("✅ subscription.created saved successfully");
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object;
          console.log(
            "🔍 subscription.updated:",
            JSON.stringify(
              {
                id: sub.id,
                status: sub.status,
                trial_end: sub.trial_end,
                current_period_end: sub.current_period_end,
              },
              null,
              2,
            ),
          );

          const freshSub = await stripe.subscriptions.retrieve(sub.id);
          await upsertSubscription(freshSub, "subscription");
          console.log(
            "🔄 Subscription updated:",
            freshSub.id,
            "→",
            freshSub.status,
          );
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          if (!invoice.subscription) break;

          const freshSub = await stripe.subscriptions.retrieve(
            invoice.subscription,
          );
          console.log(
            "💰 invoice.paid - fresh sub:",
            JSON.stringify(
              {
                id: freshSub.id,
                status: freshSub.status,
                trial_end: freshSub.trial_end,
                current_period_end: freshSub.current_period_end,
              },
              null,
              2,
            ),
          );

          await upsertSubscription(freshSub, "subscription");
          console.log("💰 Payment success:", invoice.subscription);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subId = invoice.subscription;
          if (!subId) break;

          const result = await pool.query(
            `SELECT current_period_end FROM subscriptions WHERE stripe_subscription_id = $1`,
            [subId],
          );

          console.log("🔍 payment_failed DB row:", result.rows);

          if (result.rows.length > 0 && result.rows[0].current_period_end) {
            const currentEnd = new Date(result.rows[0].current_period_end);
            const graceEnd = new Date(currentEnd);
            graceEnd.setDate(graceEnd.getDate() + 10);

            await pool.query(
              `UPDATE subscriptions SET status = 'past_due', grace_period_end = $1 WHERE stripe_subscription_id = $2`,
              [graceEnd, subId],
            );
            console.log("⚠️ Grace period set until:", graceEnd);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          await pool.query(
            `UPDATE subscriptions SET status = 'canceled', grace_period_end = NULL WHERE stripe_subscription_id = $1`,
            [sub.id],
          );
          console.log("❌ Subscription canceled:", sub.id);
          break;
        }

        default:
          console.log("⚠️ Unhandled event:", event.type);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
      res.sendStatus(500);
    }
  },
);

// =========================================
// HELPER: Upsert subscription into DB
// lookupBy: "customer" | "subscription"
// =========================================
async function upsertSubscription(sub, lookupBy) {
  const trialEnd = sub.trial_end ?? null;
  const periodEnd = sub.current_period_end ?? null;

  // Grace period only applies AFTER a paid period — not during trial
  const gracePeriod =
    sub.status === "trialing"
      ? null
      : periodEnd
        ? new Date((periodEnd + 10 * 24 * 60 * 60) * 1000)
        : null;

  console.log("💾 Writing to DB:", {
    id: sub.id,
    status: sub.status,
    trialEnd: trialEnd ? new Date(trialEnd * 1000) : null,
    periodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    gracePeriod,
    lookupBy,
  });

  if (lookupBy === "customer") {
    const result = await pool.query(
      `
      UPDATE subscriptions
      SET
        stripe_subscription_id = $1,
        status                 = $2,
        current_period_end     = to_timestamp($3),
        trial_end              = to_timestamp($4),
        grace_period_end       = $5
      WHERE stripe_customer_id = $6
      RETURNING *
      `,
      [sub.id, sub.status, periodEnd, trialEnd, gracePeriod, sub.customer],
    );
    console.log("💾 DB UPDATE RESULT (by customer):", result.rows);
  } else {
    const result = await pool.query(
      `
      UPDATE subscriptions
      SET
        status             = $1,
        current_period_end = to_timestamp($2),
        trial_end          = to_timestamp($3),
        grace_period_end   = $4
      WHERE stripe_subscription_id = $5
      RETURNING *
      `,
      [sub.status, periodEnd, trialEnd, gracePeriod, sub.id],
    );
    console.log("💾 DB UPDATE RESULT (by sub id):", result.rows);
  }
}

export default router;
