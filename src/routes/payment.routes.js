import express from "express";
import Stripe from "stripe";
import { pool } from "../config/db.js";

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

// Reverse map: Stripe price ID → plan key (live source of truth)
const PLAN_BY_PRICE_ID = {
  [process.env.STRIPE_BASE_PRICE_ID]: "base",
  [process.env.STRIPE_PROFESSIONAL_PRICE_ID]: "professional",
  [process.env.STRIPE_FULL_ACCESS_PRICE_ID]: "full_access",
};

// Tier order — higher index = higher tier
const PLAN_TIER = {
  base: 1,
  professional: 2,
  full_access: 3,
};

const VALID_PLANS = ["base", "professional", "full_access"];

// =========================================
// TRIAL CODE VALIDATION
// The "coupon" lives in our trial_codes table (NOT in Stripe), because
// trial_period_days can only be set when the checkout session is created.
// One trial per user: enforced via subscriptions.trial_code (one row/user).
// Returns { ok: true, trialDays, code } or { ok: false, reason }.
// =========================================

async function validateTrialCode(code, userId) {
  if (!code) return { ok: false, reason: "No code provided" };

  const normalized = code.trim().toUpperCase();

  const { rows } = await pool.query(
    `SELECT trial_days, active, max_redemptions, times_redeemed, expires_at
       FROM trial_codes WHERE code = $1`,
    [normalized],
  );
  const tc = rows[0];

  if (!tc) return { ok: false, reason: "Invalid code" };
  if (!tc.active) return { ok: false, reason: "Code is no longer active" };
  if (tc.expires_at && new Date(tc.expires_at) < new Date())
    return { ok: false, reason: "Code has expired" };
  if (tc.max_redemptions !== null && tc.times_redeemed >= tc.max_redemptions)
    return { ok: false, reason: "Code redemption limit reached" };

  // One trial per user — if their row already has a trial_code, they've used it
  const used = await pool.query(
    `SELECT 1 FROM subscriptions WHERE user_id = $1 AND trial_code IS NOT NULL`,
    [userId],
  );
  if (used.rows.length)
    return { ok: false, reason: "You have already used a free trial" };

  return { ok: true, trialDays: tc.trial_days, code: normalized };
}

// =========================================
// VALIDATE TRIAL CODE (live check for the frontend)
// Lets the pricing page show "✓ 14-day trial applied" before checkout.
// =========================================

router.post("/validate-trial-code", async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code)
      return res.status(400).json({ error: "Missing fields: userId, code" });

    const result = await validateTrialCode(code, userId);

    if (!result.ok) return res.json({ valid: false, reason: result.reason });

    return res.json({
      valid: true,
      trial_days: result.trialDays,
      message: `${result.trialDays}-day free trial will be applied.`,
    });
  } catch (error) {
    console.error("❌ validate-trial-code error:", error);
    return res.status(500).json({ error: "Failed to validate code" });
  }
});

// =========================================
// CREATE CHECKOUT SESSION  (new subscriber)
// Trial is GATED: granted only when a valid trialCode is supplied.
// No code → billed from day one.
// =========================================

router.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      userId,
      email,
      plan,
      referralCode = null,
      trialCode = null,
    } = req.body;

    if (!userId || !email || !plan)
      return res
        .status(400)
        .json({ error: "Missing required fields: userId, email, plan" });

    if (!VALID_PLANS.includes(plan))
      return res.status(400).json({
        error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
      });

    const priceId = PRICE_MAP[plan];
    if (!priceId)
      return res
        .status(500)
        .json({ error: `Price ID not configured for plan: ${plan}` });

    // ─── Validate trial code (if supplied). We DON'T count it here — the
    //     webhook counts it once the subscription is actually created, so
    //     abandoned checkouts never burn a redemption. ──────────────────────

    let trial = null;
    if (trialCode) {
      trial = await validateTrialCode(trialCode, userId);
      if (!trial.ok) return res.status(400).json({ error: trial.reason });
    }

    // ─── Existing customer check ───────────────────────────────────────────

    let customerId;
    const existing = await pool.query(
      `SELECT stripe_customer_id, stripe_subscription_id
         FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
      customerId = existing.rows[0].stripe_customer_id;
      if (existing.rows[0].stripe_subscription_id)
        return res.status(400).json({
          error:
            "User already has an active subscription. Use update-subscription-plans to change plan.",
        });
    } else {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
    }

    // ─── Upsert placeholder row ────────────────────────────────────────────

    await pool.query(
      `INSERT INTO subscriptions (user_id, stripe_customer_id, referral_code, status)
       VALUES ($1, $2, $3, 'inactive')
       ON CONFLICT (user_id) DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         referral_code      = EXCLUDED.referral_code,
         updated_at         = NOW()`,
      [userId, customerId, referralCode],
    );

    // ─── Build subscription_data — trial ONLY when a valid code exists ─────

    const subscription_data = { metadata: { userId: String(userId) } };
    if (trial?.ok) {
      subscription_data.trial_period_days = trial.trialDays;
      subscription_data.metadata.trialCode = trial.code;
    }

    // ─── Stripe Checkout ───────────────────────────────────────────────────
    // allow_promotion_codes is for real discounts only (separate from trials).
    // Remove it if you don't offer discount coupons.

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      allow_promotion_codes: true,
      payment_method_collection: "always",
      metadata: { userId: String(userId) },
      subscription_data,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://www.auditprorx.com/Mainpage?payment=success",
      cancel_url: "https://www.auditprorx.com/cancel",
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Checkout error:", error);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// =========================================
// UPGRADE / DOWNGRADE SUBSCRIPTION
//
//  UPGRADE   → applied immediately, prorated, access via webhook
//  DOWNGRADE → scheduled for end of billing period (keeps higher access until then)
//
// Current plan is resolved from the LIVE Stripe price ID (not the DB column),
// so a stale/null subscription_type can never misroute an upgrade into the
// downgrade branch.
// =========================================

router.post("/update-subscription-plans", async (req, res) => {
  try {
    const { userId, plan } = req.body;

    if (!userId || !plan)
      return res.status(400).json({ error: "Missing fields: userId, plan" });

    if (!VALID_PLANS.includes(plan))
      return res.status(400).json({
        error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
      });

    const newPriceId = PRICE_MAP[plan];
    if (!newPriceId)
      return res
        .status(500)
        .json({ error: `Price ID not configured for plan: ${plan}` });

    const result = await pool.query(
      `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    const row = result.rows[0];
    if (!row?.stripe_subscription_id)
      return res.status(404).json({ error: "No active subscription found" });

    const subscriptionId = row.stripe_subscription_id;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (subscription.status === "canceled")
      return res.status(400).json({
        error: "Subscription is canceled. Please subscribe again.",
      });

    const currentItem = subscription.items.data[0];
    if (!currentItem)
      return res
        .status(500)
        .json({ error: "Could not find current subscription item" });

    const currentItemId = currentItem.id;

    // Current plan resolved from the LIVE Stripe price ID (not the DB, which can lag)
    const currentPlanKey = PLAN_BY_PRICE_ID[currentItem.price?.id] || null;

    if (!PLAN_TIER[currentPlanKey])
      return res.status(400).json({
        error: "Could not determine current plan from Stripe. Contact support.",
      });

    if (currentPlanKey === plan)
      return res.status(400).json({ error: "User is already on this plan" });

    const isUpgrade = PLAN_TIER[plan] > PLAN_TIER[currentPlanKey];

    // ─── UPGRADE — immediate, prorated ────────────────────────────────────

    if (isUpgrade) {
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: currentItemId, price: newPriceId }],
        proration_behavior: "create_prorations",
      });

      console.log(`✅ Upgraded user ${userId}: ${currentPlanKey} → ${plan}`);

      return res.json({
        success: true,
        type: "upgrade",
        message: `Upgraded to ${plan}. Access updated immediately.`,
      });
    }

    // ─── DOWNGRADE — takes effect at end of billing period ────────────────
    // Period fields can live on the subscription OR on the item depending on
    // the Stripe API version — read both, prefer the subscription.

    const periodStart =
      subscription.current_period_start ?? currentItem.current_period_start;
    const periodEnd =
      subscription.current_period_end ?? currentItem.current_period_end;
    const currentPriceId = currentItem.price.id;
    let schedule;

    if (subscription.schedule) {
      schedule = await stripe.subscriptionSchedules.update(
        subscription.schedule,
        {
          phases: [
            {
              items: [{ price: currentPriceId }],
              start_date: periodStart,
              end_date: periodEnd,
              trial_end: subscription.trial_end || undefined,
            },
            { items: [{ price: newPriceId }], start_date: periodEnd },
          ],
          end_behavior: "release",
        },
      );
    } else {
      schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });

      schedule = await stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            items: [{ price: currentPriceId }],
            start_date: periodStart,
            end_date: periodEnd,
          },
          { items: [{ price: newPriceId }], start_date: periodEnd },
        ],
        end_behavior: "release",
      });
    }

    await pool.query(
      `UPDATE subscriptions SET pending_plan = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [plan, userId],
    );

    console.log(
      `⏬ Downgrade scheduled for user ${userId}: ${currentPlanKey} → ${plan} at period end`,
    );

    return res.json({
      success: true,
      type: "downgrade",
      effective_date: new Date(periodEnd * 1000),
      message: `Downgrade to ${plan} scheduled. Current access continues until ${new Date(
        periodEnd * 1000,
      ).toLocaleDateString()}.`,
    });
  } catch (error) {
    console.error("❌ Update subscription error:", error);
    return res.status(500).json({ error: "Failed to update subscription" });
  }
});

// =========================================
// CANCEL SUBSCRIPTION
//  In trial → cancel immediately (no charge)
//  Paid     → cancel at period end (access until then)
// =========================================

router.post("/cancel-subscription", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const result = await pool.query(
      `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    if (!result.rows.length || !result.rows[0].stripe_subscription_id)
      return res.status(404).json({ error: "No active subscription found" });

    const stripeSubscriptionId = result.rows[0].stripe_subscription_id;
    const subscription =
      await stripe.subscriptions.retrieve(stripeSubscriptionId);

    if (subscription.status === "canceled")
      return res
        .status(400)
        .json({ error: "Subscription is already canceled" });

    // ── In trial: cancel immediately, user never charged ──────────────────
    // NOTE: trial_code is intentionally NOT cleared — it stays as the
    // permanent "this user already used a trial" marker.

    if (subscription.status === "trialing") {
      await stripe.subscriptions.cancel(stripeSubscriptionId);

      await pool.query(
        `UPDATE subscriptions
         SET status='canceled', subscription_type='none', cancel_at_period_end=false,
             inventory_reports_access=false, inventory_view_access=false,
             drug_lookup_access=false, leads_access=false, full_access=false,
             active_price_ids=ARRAY[]::TEXT[], trial_end=NULL, grace_period_end=NULL,
             updated_at=NOW()
         WHERE user_id = $1`,
        [userId],
      );

      console.log(`🚫 Trial canceled immediately for user ${userId}`);

      return res.json({
        success: true,
        type: "immediate",
        message: "Trial canceled. You have not been charged.",
      });
    }

    // ── Paid: cancel at period end ────────────────────────────────────────
    // Read period end from the subscription OR the item (API-version safe).

    const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    const cancelPeriodEnd =
      updated.current_period_end ??
      updated.items?.data?.[0]?.current_period_end;
    const gracePeriodEnd = new Date(cancelPeriodEnd * 1000);

    await pool.query(
      `UPDATE subscriptions
       SET cancel_at_period_end=true, grace_period_end=to_timestamp($1), updated_at=NOW()
       WHERE user_id = $2`,
      [cancelPeriodEnd, userId],
    );

    console.log(`⏰ Cancellation scheduled at period end for user ${userId}`);

    return res.json({
      success: true,
      type: "at_period_end",
      grace_period_end: gracePeriodEnd,
      message: `Subscription canceled. Access until ${gracePeriodEnd.toLocaleDateString()}.`,
    });
  } catch (error) {
    console.error("❌ Cancel error:", error);
    return res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

// =========================================
// REACTIVATE SUBSCRIPTION (undo a pending cancel)
// =========================================

router.post("/reactivate-subscription", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const result = await pool.query(
      `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    const stripeSubscriptionId = result.rows[0]?.stripe_subscription_id;
    if (!stripeSubscriptionId)
      return res.status(404).json({ error: "No subscription found" });

    const subscription =
      await stripe.subscriptions.retrieve(stripeSubscriptionId);

    if (!subscription.cancel_at_period_end)
      return res
        .status(400)
        .json({ error: "Subscription is not pending cancellation" });

    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    await pool.query(
      `UPDATE subscriptions
       SET cancel_at_period_end=false, grace_period_end=NULL, updated_at=NOW()
       WHERE user_id = $1`,
      [userId],
    );

    console.log(`♻️  Subscription reactivated for user ${userId}`);

    return res.json({
      success: true,
      message: "Subscription reactivated successfully.",
    });
  } catch (error) {
    console.error("❌ Reactivate error:", error);
    return res.status(500).json({ error: "Failed to reactivate subscription" });
  }
});

// =========================================
// BILLING PORTAL
// =========================================

router.post("/update-subscription", async (req, res) => {
  try {
    const { userId } = req.body;

    const result = await pool.query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    if (!result.rows.length)
      return res.status(404).json({ error: "Subscription not found" });

    const session = await stripe.billingPortal.sessions.create({
      customer: result.rows[0].stripe_customer_id,
      return_url: "https://www.auditprorx.com/settings",
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to open billing portal" });
  }
});

// =========================================
// ADMIN ACCESS CONTROL
// Comp a client without making them pay. Booleans are coerced so partial
// grants never hit the NOT NULL columns, and subscription_type is set so the
// UI shows a real plan label instead of null.
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

    let inventoryReports = Boolean(inventory_reports_access);
    let inventoryView = Boolean(inventory_view_access);
    let drugLookup = Boolean(drug_lookup_access);
    let leads = Boolean(leads_access);
    const fullAccess = Boolean(full_access);

    if (fullAccess) {
      inventoryReports = true;
      inventoryView = true;
      drugLookup = true;
      leads = true;
    }

    // Clean plan label so the UI shows a real plan instead of null
    const subscriptionType = fullAccess
      ? "full_access"
      : inventoryView
        ? "professional"
        : inventoryReports
          ? "base"
          : "none";

    await pool.query(
      `INSERT INTO subscriptions (
         user_id, status, admin_override, subscription_type,
         inventory_reports_access, inventory_view_access,
         drug_lookup_access, leads_access, full_access, updated_at
       )
       VALUES ($1, 'active', true, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         status='active', admin_override=true,
         subscription_type=EXCLUDED.subscription_type,
         inventory_reports_access=EXCLUDED.inventory_reports_access,
         inventory_view_access=EXCLUDED.inventory_view_access,
         drug_lookup_access=EXCLUDED.drug_lookup_access,
         leads_access=EXCLUDED.leads_access,
         full_access=EXCLUDED.full_access,
         updated_at=NOW()`,
      [
        userId,
        subscriptionType,
        inventoryReports,
        inventoryView,
        drugLookup,
        leads,
        fullAccess,
      ],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to grant access" });
  }
});

// =========================================
// GET SUBSCRIPTION (DB)
// =========================================

router.get("/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    return res.json({ subscription: result.rows[0] || null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch subscription" });
  }
});

// =========================================
// GET LIVE STRIPE SUBSCRIPTION DETAILS
// =========================================

router.get("/stripe-subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    if (!result.rows.length)
      return res.status(404).json({ error: "Subscription not found" });

    const dbSub = result.rows[0];

    // ── Admin-granted client — access comped, no Stripe subscription. ──────
    // Return a real plan label + price from the DB flags so the UI doesn't
    // show "No Active Plan / $0".

    if (!dbSub.stripe_subscription_id && dbSub.admin_override) {
      const planKey =
        dbSub.subscription_type && dbSub.subscription_type !== "none"
          ? dbSub.subscription_type
          : dbSub.full_access
            ? "full_access"
            : dbSub.inventory_view_access
              ? "professional"
              : dbSub.inventory_reports_access
                ? "base"
                : "none";

      const adminLabels = {
        base: "Base — Inventory Reports ($99/mo)",
        professional: "Professional ($249/mo)",
        full_access: "Complete Suite ($499/mo)",
        none: "Admin Access",
      };
      const adminAmounts = {
        base: 9900,
        professional: 24900,
        full_access: 49900,
        none: 0,
      };

      return res.json({
        subscription: {
          status: "active",
          current_plan: adminLabels[planKey],
          active_plans: planKey === "none" ? [] : [planKey],
          current_period_end: null,
          current_period_start: null,
          cancel_at_period_end: false,
          auto_renew: false,
          amount: adminAmounts[planKey],
          currency: "usd",
          trial_end: null,
          pending_plan: null,
          subscription_type: dbSub.subscription_type,
          admin_override: true,
        },
      });
    }

    if (!dbSub.stripe_subscription_id)
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
          trial_end: null,
          pending_plan: null,
        },
      });

    const subscription = await stripe.subscriptions.retrieve(
      dbSub.stripe_subscription_id,
      { expand: ["items.data.price", "latest_invoice"] },
    );

    // Derive the plan from the LIVE Stripe price IDs so the label and the
    // amount (also from Stripe) always agree — no stale-DB mismatch.
    const livePlanKey =
      subscription.items.data
        .map((item) => PLAN_BY_PRICE_ID[item.price?.id])
        .find(Boolean) || null;

    const active_plans = livePlanKey ? [livePlanKey] : [];

    const labels = {
      base: "Base — Inventory Reports ($99/mo)",
      professional:
        "Professional — Inventory Reports + Inventory View ($249/mo)",
      full_access: "Complete Suite ($499/mo)",
    };

    const formatPlanName = (plans) =>
      plans.length
        ? plans.map((p) => labels[p] || p).join(", ")
        : "No Active Plan";

    let amount = 0;
    let currency = "usd";
    subscription.items.data.forEach((item) => {
      amount += item.price?.unit_amount || 0;
      currency = item.price?.currency || "usd";
    });

    const periodEnd =
      subscription.current_period_end ||
      subscription.items?.data?.[0]?.current_period_end ||
      null;
    const periodStart =
      subscription.current_period_start ||
      subscription.items?.data?.[0]?.current_period_start ||
      null;
    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000)
      : null;

    return res.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: periodEnd ? new Date(periodEnd * 1000) : null,
        current_period_start: periodStart ? new Date(periodStart * 1000) : null,
        trial_end: trialEnd,
        customer: subscription.customer,
        current_plan: formatPlanName(active_plans),
        active_plans,
        auto_renew: !subscription.cancel_at_period_end,
        amount,
        currency,
        subscription_type: dbSub.subscription_type,
        grace_period_end: dbSub.grace_period_end,
        admin_override: dbSub.admin_override,
        pending_plan: dbSub.pending_plan || null,
        trial_code: dbSub.trial_code || null,
      },
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ error: "Failed to fetch Stripe subscription" });
  }
});

export default router;
