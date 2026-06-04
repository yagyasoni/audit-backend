import express from "express";
import Stripe from "stripe";
import { pool } from "./db.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  base: process.env.STRIPE_BASE_PRICE_ID,

  inventory_view: process.env.STRIPE_INVENTORY_PRICE_ID,

  drug_lookup: process.env.STRIPE_DRUG_LOOKUP_PRICE_ID,

  leads: process.env.STRIPE_LEADS_PRICE_ID,

  full_access: process.env.STRIPE_FULL_ACCESS_PRICE_ID,
};

router.post(
  "/",
  express.raw({
    type: "application/json",
  }),

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
        case "checkout.session.completed":

        case "customer.subscription.created":

        case "customer.subscription.updated":

        case "invoice.paid": {
          let subscription;

          // =====================================
          // CHECKOUT SESSION
          // =====================================

          if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            if (!session.subscription) break;

            subscription = await stripe.subscriptions.retrieve(
              session.subscription,
            );

            // FIX MISSING METADATA
            if (!subscription.metadata?.userId && session.metadata?.userId) {
              await stripe.subscriptions.update(subscription.id, {
                metadata: {
                  userId: session.metadata.userId,
                },
              });

              subscription = await stripe.subscriptions.retrieve(
                subscription.id,
              );
            }
          }

          // =====================================
          // INVOICE PAID
          // =====================================
          else if (event.type === "invoice.paid") {
            const invoice = event.data.object;

            if (!invoice.subscription) break;

            subscription = await stripe.subscriptions.retrieve(
              invoice.subscription,
            );
          }

          // =====================================
          // SUB CREATED / UPDATED
          // =====================================
          else {
            const subObject = event.data.object;

            subscription = await stripe.subscriptions.retrieve(subObject.id);
          }

          console.log("=================================");
          console.log("EVENT:", event.type);
          console.log("SUB ID:", subscription.id);
          console.log("METADATA:", subscription.metadata);
          console.log("=================================");

          await syncSubscription(subscription);

          break;
        }

        // =====================================
        // PAYMENT FAILED
        // =====================================

        case "invoice.payment_failed": {
          const invoice = event.data.object;

          if (!invoice.subscription) break;

          await pool.query(
            `
            UPDATE subscriptions
            SET
              status = 'past_due',
              updated_at = NOW()
            WHERE stripe_subscription_id = $1
            `,
            [invoice.subscription],
          );

          break;
        }

        // =====================================
        // SUB DELETED
        // =====================================

        case "customer.subscription.deleted": {
          const subscription = event.data.object;

          await pool.query(
            `
            UPDATE subscriptions
            SET
              status = 'canceled',

              subscription_type = 'none',

              inventory_reports_access = false,

              inventory_view_access = false,

              drug_lookup_access = false,

              leads_access = false,

              full_access = false,

              active_price_ids = ARRAY[]::TEXT[],

              cancel_at_period_end = false,

              updated_at = NOW()

            WHERE stripe_subscription_id = $1
            `,
            [subscription.id],
          );

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
// SYNC SUBSCRIPTION
// =========================================

async function syncSubscription(subscription) {
  try {
    const userId =
      subscription.metadata?.userId ||
      subscription.metadata?.userid ||
      subscription.metadata?.user_id;

    console.log("USER ID:", userId);

    if (!userId) {
      console.log("❌ Missing userId metadata");

      return;
    }

    const activePriceIds = subscription.items.data.map((item) => item.price.id);

    console.log("PRICE IDS:", activePriceIds);

    let inventory_reports_access = false;

    let inventory_view_access = false;

    let drug_lookup_access = false;

    let leads_access = false;

    let full_access = false;

    // FULL ACCESS
    if (activePriceIds.includes(PRICE_MAP.full_access)) {
      full_access = true;

      inventory_reports_access = true;

      inventory_view_access = true;

      drug_lookup_access = true;

      leads_access = true;
    } else {
      // BASE
      if (activePriceIds.includes(PRICE_MAP.base)) {
        inventory_reports_access = true;
      }

      // ADDONS REQUIRE BASE
      if (inventory_reports_access) {
        if (activePriceIds.includes(PRICE_MAP.inventory_view)) {
          inventory_view_access = true;
        }

        if (activePriceIds.includes(PRICE_MAP.drug_lookup)) {
          drug_lookup_access = true;
        }

        if (activePriceIds.includes(PRICE_MAP.leads)) {
          leads_access = true;
        }
      }
    }

    let subscriptionType = "none";

    if (full_access) {
      subscriptionType = "full_access";
    } else {
      const types = [];

      if (inventory_reports_access) {
        types.push("base");
      }

      if (inventory_view_access) {
        types.push("inventory_view");
      }

      if (drug_lookup_access) {
        types.push("drug_lookup");
      }

      if (leads_access) {
        types.push("leads");
      }

      subscriptionType = types.join("+");
    }

    console.log("SYNCING TO DATABASE...");

    await pool.query(
      `
      INSERT INTO subscriptions (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        current_period_end,
        cancel_at_period_end,
        subscription_type,

        inventory_reports_access,
        inventory_view_access,
        drug_lookup_access,
        leads_access,
        full_access,

        active_price_ids,
         grace_period_end,

        updated_at
      )

      VALUES (
        $1,
        $2,
        $3,
        $4,

        $5,

        $6,
        $7,

        $8,
        $9,
        $10,
        $11,
        $12,

        $13,
        NULL,

        NOW()
      )

      ON CONFLICT (user_id)

      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,

        stripe_subscription_id =
          EXCLUDED.stripe_subscription_id,

        status = EXCLUDED.status,

        current_period_end =
          EXCLUDED.current_period_end,

        cancel_at_period_end =
          EXCLUDED.cancel_at_period_end,

        subscription_type =
          EXCLUDED.subscription_type,

        inventory_reports_access =
          EXCLUDED.inventory_reports_access,

        inventory_view_access =
          EXCLUDED.inventory_view_access,

        drug_lookup_access =
          EXCLUDED.drug_lookup_access,

        leads_access =
          EXCLUDED.leads_access,

        full_access =
          EXCLUDED.full_access,

        active_price_ids =
          EXCLUDED.active_price_ids,

        grace_period_end =
  CASE
    WHEN EXCLUDED.cancel_at_period_end = false
    THEN NULL
    ELSE subscriptions.grace_period_end
  END,

        updated_at = NOW()
      `,
      [
        userId,
        subscription.customer,
        subscription.id,
        subscription.status,
        (() => {
          const currentPeriodEnd =
            subscription.current_period_end ||
            subscription.items?.data?.[0]?.current_period_end;

          return currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null;
        })(),
        subscription.cancel_at_period_end,
        subscriptionType,

        inventory_reports_access,
        inventory_view_access,
        drug_lookup_access,
        leads_access,
        full_access,

        activePriceIds,
      ],
    );

    console.log("✅ Subscription synced to PostgreSQL");
  } catch (error) {
    console.error("❌ syncSubscription FULL ERROR:", error);

    if (error?.detail) {
      console.error("DETAIL:", error.detail);
    }

    if (error?.constraint) {
      console.error("CONSTRAINT:", error.constraint);
    }
  }
}

export default router;
