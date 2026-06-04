import express from "express";
import Stripe from "stripe";
import { pool } from "../config/db.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  base: process.env.STRIPE_BASE_PRICE_ID,

  inventory_view: process.env.STRIPE_INVENTORY_PRICE_ID,

  drug_lookup: process.env.STRIPE_DRUG_LOOKUP_PRICE_ID,

  leads: process.env.STRIPE_LEADS_PRICE_ID,

  full_access: process.env.STRIPE_FULL_ACCESS_PRICE_ID,
};

// =========================================
// CREATE CHECKOUT SESSION
// =========================================

router.post("/create-checkout-session", async (req, res) => {
  try {
    const { userId, email, plans = [], referralCode = null } = req.body;

    if (!userId || !email || plans.length === 0) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    // FULL ACCESS CANNOT COMBINE
    if (plans.includes("full_access") && plans.length > 1) {
      return res.status(400).json({
        error: "Full access cannot be combined",
      });
    }

    // BASE REQUIRED
    const addonPlans = ["inventory_view", "drug_lookup", "leads"];

    const hasBase = plans.includes("base");

    const hasAddon = plans.some((p) => addonPlans.includes(p));

    if (hasAddon && !hasBase) {
      return res.status(400).json({
        error: "Base plan required for addons",
      });
    }

    // =========================================
    // EXISTING CUSTOMER
    // =========================================

    let customerId;

    const existing = await pool.query(
      `
      SELECT stripe_customer_id
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
      customerId = existing.rows[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email,
      });

      customerId = customer.id;
    }

    // =========================================
    // LINE ITEMS
    // =========================================

    const lineItems = plans.map((plan) => ({
      price: PRICE_MAP[plan],
      quantity: 1,
    }));

    // =========================================
    // UPSERT TEMP RECORD
    // =========================================

    await pool.query(
      `
      INSERT INTO subscriptions (
        user_id,
        stripe_customer_id,
        referral_code,
        status
      )

      VALUES (
        $1,
        $2,
        $3,
        'inactive'
      )

      ON CONFLICT (user_id)

      DO UPDATE SET
        stripe_customer_id =
          EXCLUDED.stripe_customer_id,

        referral_code =
          EXCLUDED.referral_code,

        updated_at = NOW()
      `,
      [userId, customerId, referralCode],
    );

    // =========================================
    // STRIPE SESSION
    // =========================================

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      customer: customerId,

      allow_promotion_codes: true,

      payment_method_collection: "always",

      metadata: {
        userId: String(userId),
      },

      subscription_data: {
        metadata: {
          userId: String(userId),
        },
      },

      line_items: lineItems,

      success_url: "https://www.auditprorx.com/Mainpage?payment=success",

      cancel_url: "https://www.auditprorx.com/cancel",
    });

    return res.json({
      url: session.url,
    });
  } catch (error) {
    console.error("❌ Checkout error:", error);

    return res.status(500).json({
      error: "Failed to create checkout session",
    });
  }
});

// =========================================
// ADMIN ACCESS CONTROL
// =========================================

router.post("/admin/grant-access", async (req, res) => {
  try {
    const {
      userId,
      inventory_reports_access,
      inventory_view_access,
      drug_lookup_access,
      leads_access,
      full_access,
    } = req.body;

    let inventoryReports = inventory_reports_access;

    let inventoryView = inventory_view_access;

    let drugLookup = drug_lookup_access;

    let leads = leads_access;

    // FULL ACCESS
    if (full_access) {
      inventoryReports = true;
      inventoryView = true;
      drugLookup = true;
      leads = true;
    }

    // BASE REQUIRED
    if (!inventoryReports && (inventoryView || drugLookup || leads)) {
      return res.status(400).json({
        error: "Base required for addons",
      });
    }

    await pool.query(
      `
      INSERT INTO subscriptions (
        user_id,
        status,
        admin_override,

        inventory_reports_access,
        inventory_view_access,
        drug_lookup_access,
        leads_access,
        full_access,

        updated_at
      )

      VALUES (
        $1,
        'active',
        true,

        $2,
        $3,
        $4,
        $5,
        $6,

        NOW()
      )

      ON CONFLICT (user_id)

      DO UPDATE SET
        status = 'active',

        admin_override = true,

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

        updated_at = NOW()
      `,
      [userId, inventoryReports, inventoryView, drugLookup, leads, full_access],
    );

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Failed to grant access",
    });
  }
});

// =========================================
// GET SUBSCRIPTION
// =========================================

router.get("/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    return res.json({
      subscription: result.rows[0] || null,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to fetch subscription",
    });
  }
});

// =========================================
// CANCEL SUBSCRIPTION
// =========================================

router.post("/cancel-subscription", async (req, res) => {
  try {
    const { userId } = req.body;

    const result = await pool.query(
      `
      SELECT stripe_subscription_id
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Subscription not found",
      });
    }

    const stripeSubscriptionId = result.rows[0].stripe_subscription_id;

    // CANCEL AT PERIOD END
    const subscription = await stripe.subscriptions.update(
      stripeSubscriptionId,
      {
        cancel_at_period_end: true,
      },
    );

    // SAVE GRACE PERIOD
    await pool.query(
      `
      UPDATE subscriptions
      SET
        cancel_at_period_end = true,

        grace_period_end =
          to_timestamp($1),

        updated_at = NOW()

      WHERE user_id = $2
      `,
      [subscription.current_period_end, userId],
    );

    return res.json({
      success: true,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to cancel subscription",
    });
  }
});

// =========================================
// UPDATE SUBSCRIPTION
// =========================================

router.post("/update-subscription", async (req, res) => {
  try {
    const { userId } = req.body;

    const result = await pool.query(
      `
      SELECT stripe_customer_id
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Subscription not found",
      });
    }

    const customerId = result.rows[0].stripe_customer_id;

    // STRIPE BILLING PORTAL
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,

      return_url: "https://www.auditprorx.com/settings",
    });

    return res.json({
      url: session.url,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to update subscription",
    });
  }
});

router.post("/update-subscription-plans", async (req, res) => {
  try {
    const { userId, plans = [] } = req.body;

    if (!userId || plans.length === 0) {
      return res.status(400).json({
        error: "Missing fields",
      });
    }

    // =====================================
    // VALIDATION
    // =====================================

    // FULL ACCESS CANNOT COMBINE
    if (plans.includes("full_access") && plans.length > 1) {
      return res.status(400).json({
        error: "Full access cannot combine",
      });
    }

    // ADDONS REQUIRE BASE
    const addonPlans = ["inventory_view", "drug_lookup", "leads"];

    const hasBase = plans.includes("base");

    const hasAddon = plans.some((p) => addonPlans.includes(p));

    if (hasAddon && !hasBase) {
      return res.status(400).json({
        error: "Base plan required for addons",
      });
    }

    // =====================================
    // GET SUBSCRIPTION
    // =====================================

    const result = await pool.query(
      `
      SELECT stripe_subscription_id
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    const subscriptionId = result.rows[0]?.stripe_subscription_id;

    if (!subscriptionId) {
      return res.status(404).json({
        error: "Subscription not found",
      });
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    // =====================================
    // REMOVE OLD ITEMS
    // =====================================

    const itemsToDelete = subscription.items.data.map((item) => ({
      id: item.id,
      deleted: true,
    }));

    // =====================================
    // ADD NEW ITEMS
    // =====================================

    const newItems = plans.map((plan) => ({
      price: PRICE_MAP[plan],
    }));

    // =====================================
    // UPDATE STRIPE SUBSCRIPTION
    // =====================================

    await stripe.subscriptions.update(subscriptionId, {
      items: [...itemsToDelete, ...newItems],

      proration_behavior: "create_prorations",
    });

    return res.json({
      success: true,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to update subscription",
    });
  }
});

// =========================================
// GET LIVE STRIPE SUBSCRIPTION DETAILS
// =========================================

// =========================================
// GET LIVE STRIPE SUBSCRIPTION DETAILS
// =========================================

router.get("/stripe-subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // =====================================
    // GET DATABASE SUB
    // =====================================

    const result = await pool.query(
      `
      SELECT *
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Subscription not found",
      });
    }

    const dbSub = result.rows[0];

    // =====================================
    // NO STRIPE SUB
    // =====================================

    if (!dbSub.stripe_subscription_id) {
      return res.json({
        subscription: {
          status: dbSub.status || "inactive",

          current_plan: "No Active Plan",

          active_plans: [],

          current_period_end: null,

          current_period_start: null,

          cancel_at_period_end: false,

          auto_renew: false,

          amount: 0,

          currency: "usd",
        },
      });
    }

    // =====================================
    // LIVE STRIPE SUB
    // =====================================

    const subscription = await stripe.subscriptions.retrieve(
      dbSub.stripe_subscription_id,
      {
        expand: ["items.data.price", "latest_invoice"],
      },
    );

    // =====================================
    // ACTIVE PLANS
    // =====================================

    const active_plans = [];

    if (dbSub.full_access) {
      active_plans.push("full_access");
    } else {
      if (dbSub.inventory_reports_access) {
        active_plans.push("base");
      }

      if (dbSub.inventory_view_access) {
        active_plans.push("inventory_view");
      }

      if (dbSub.drug_lookup_access) {
        active_plans.push("drug_lookup");
      }

      if (dbSub.leads_access) {
        active_plans.push("leads");
      }
    }

    // =====================================
    // CURRENT PLAN LABEL
    // =====================================

    const formatPlanName = (plans) => {
      if (!plans.length) {
        return "No Active Plan";
      }

      const labels = {
        base: "Inventory Reports",
        inventory_view: "Inventory View",
        drug_lookup: "Drug Lookup",
        leads: "Leads",
        full_access: "Complete Suite",
      };

      return plans.map((p) => labels[p] || p).join(" + ");
    };

    // =====================================
    // PRICING
    // =====================================

    let amount = 0;

    let currency = "usd";

    subscription.items.data.forEach((item) => {
      amount += item.price?.unit_amount || 0;

      currency = item.price?.currency || "usd";
    });

    // =====================================
    // RESPONSE
    // =====================================

    const currentPeriodEnd =
      subscription.current_period_end ||
      subscription.items?.data?.[0]?.current_period_end ||
      null;

    const currentPeriodStart =
      subscription.current_period_start ||
      subscription.items?.data?.[0]?.current_period_start ||
      null;

    return res.json({
      subscription: {
        id: subscription.id,

        status: subscription.status,

        cancel_at_period_end: subscription.cancel_at_period_end,

        // current_period_end: subscription.current_period_end
        //   ? new Date(subscription.current_period_end * 1000)
        //   : null,

        // current_period_start: subscription.current_period_start
        //   ? new Date(subscription.current_period_start * 1000)
        //   : null,

        current_period_end: currentPeriodEnd
          ? new Date(currentPeriodEnd * 1000)
          : null,

        current_period_start: currentPeriodStart
          ? new Date(currentPeriodStart * 1000)
          : null,

        customer: subscription.customer,

        current_plan: formatPlanName(active_plans),

        active_plans,

        auto_renew: !subscription.cancel_at_period_end,

        amount,

        currency,

        subscription_type: dbSub.subscription_type,

        grace_period_end: dbSub.grace_period_end,

        admin_override: dbSub.admin_override,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to fetch Stripe subscription",
    });
  }
});

export default router;
