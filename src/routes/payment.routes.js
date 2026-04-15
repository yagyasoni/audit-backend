// import express from "express";
// import Stripe from "stripe";
// import { pool } from "../config/db.js"; // adjust path if needed

// const router = express.Router();

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// // =======================================================
// // CREATE CHECKOUT SESSION
// // =======================================================
// router.post("/create-checkout-session", async (req, res) => {
//   try {
//     const { userId, email } = req.body;

//     // -----------------------------
//     // VALIDATION
//     // -----------------------------
//     if (!userId || !email) {
//       return res.status(400).json({
//         error: "Missing userId or email",
//       });
//     }

//     // -----------------------------
//     // CHECK EXISTING CUSTOMER
//     // -----------------------------
//     let customerId;

//     const existing = await pool.query(
//       `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
//       [userId],
//     );

//     if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
//       customerId = existing.rows[0].stripe_customer_id;
//     } else {
//       const customer = await stripe.customers.create({
//         email,
//       });
//       customerId = customer.id;
//     }

//     // -----------------------------
//     // INSERT (IMPORTANT FIX)
//     // -----------------------------
//     await pool.query(
//       `
//   INSERT INTO subscriptions (user_id, stripe_customer_id, status)
//   VALUES ($1, $2, $3)
//   ON CONFLICT (user_id)
//   DO UPDATE SET
//     stripe_customer_id = EXCLUDED.stripe_customer_id,
//     status = EXCLUDED.status
//   `,
//       [userId, customerId, "trialing"],
//     );

//     // -----------------------------
//     // CREATE CHECKOUT SESSION
//     // -----------------------------
//     const session = await stripe.checkout.sessions.create({
//       mode: "subscription",
//       customer: customerId,

//       line_items: [
//         {
//           price: "price_1TJAu7BsVpwEk4PVFt7kEy8V", // 🔴 replace with your real price ID
//           quantity: 1,
//         },
//       ],

//       subscription_data: {
//         trial_period_days: 7,
//       },

//       success_url: "http://localhost:3000/info-page",
//       cancel_url: "https://your-frontend.com/coming-soon",
//     });

//     // -----------------------------
//     // RESPONSE
//     // -----------------------------
//     return res.json({ url: session.url });
//   } catch (error) {
//     console.error("Stripe session error:", error);

//     console.error("🔥 FULL ERROR:", error);

//     return res.status(500).json({
//       error: "Failed to create checkout session",
//       message: error.message,
//       type: error.type,
//       raw: error.raw?.message,
//     });
//   }
// });

// export default router;

// import express from "express";
// import Stripe from "stripe";
// import { pool } from "../config/db.js";

// const router = express.Router();
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// // =========================================
// // CREATE CHECKOUT SESSION (ONLY)
// // =========================================
// router.post("/create-checkout-session", async (req, res) => {
//   try {
//     const { userId, email } = req.body;

//     if (!userId || !email) {
//       return res.status(400).json({
//         error: "Missing userId or email",
//       });
//     }

//     let customerId;

//     // Check if customer exists
//     const existing = await pool.query(
//       `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
//       [userId],
//     );

//     if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
//       customerId = existing.rows[0].stripe_customer_id;
//     } else {
//       const customer = await stripe.customers.create({ email });
//       customerId = customer.id;
//     }

//     // Create checkout session ONLY
//     const session = await stripe.checkout.sessions.create({
//       mode: "subscription",
//       customer: customerId,

//       metadata: {
//         userId: userId, // 🔥 VERY IMPORTANT
//       },

//       line_items: [
//         {
//           price: "price_1TJAu7BsVpwEk4PVFt7kEy8V",
//           quantity: 1,
//         },
//       ],

//       subscription_data: {
//         trial_period_days: 7,
//       },

//       success_url: "http://localhost:3000/info-page",
//       cancel_url: "http://localhost:3000/cancel",
//     });

//     return res.json({ url: session.url });
//   } catch (error) {
//     console.error(error);
//     return res.status(500).json({
//       error: "Failed to create session",
//     });
//   }
// });

// // =========================================
// // CANCEL SUBSCRIPTION
// // =========================================
// router.post("/cancel-subscription", async (req, res) => {
//   try {
//     const { userId } = req.body;

//     const result = await pool.query(
//       `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
//       [userId],
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         error: "Subscription not found",
//       });
//     }

//     const subscriptionId = result.rows[0].stripe_subscription_id;

//     // Cancel at period end (recommended)
//     await stripe.subscriptions.update(subscriptionId, {
//       cancel_at_period_end: true,
//     });

//     return res.json({
//       message: "Subscription will cancel at period end",
//     });
//   } catch (error) {
//     console.error(error);
//     return res.status(500).json({
//       error: "Failed to cancel subscription",
//     });
//   }
// });

// // GET subscription details by userId
// router.get("/subscription/:userId", async (req, res) => {
//   try {
//     const { userId } = req.params;

//     const result = await pool.query(
//       `SELECT
//         stripe_subscription_id,
//         stripe_customer_id,
//         status,
//         current_period_end
//        FROM subscriptions
//        WHERE user_id = $1`,
//       [userId],
//     );

//     if (result.rows.length === 0) {
//       return res.json({ subscription: null });
//     }

//     return res.json({
//       subscription: result.rows[0],
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Failed to fetch subscription" });
//   }
// });

// export default router;

import express from "express";
import Stripe from "stripe";
import { pool } from "../config/db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =========================================
// CREATE CHECKOUT SESSION
// =========================================
router.post("/create-checkout-session", async (req, res) => {
  try {
    const { userId, email } = req.body;

    // ✅ VALIDATION
    if (!userId || !email) {
      return res.status(400).json({
        error: "Missing userId or email",
      });
    }

    let customerId;

    // =========================================
    // CHECK EXISTING CUSTOMER
    // =========================================
    const existing = await pool.query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
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
    // 🔥 IMPORTANT: INSERT BEFORE CHECKOUT
    // =========================================
    await pool.query(
      `
      INSERT INTO subscriptions (user_id, stripe_customer_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        status = EXCLUDED.status
      `,
      [userId, customerId, "trialing"],
    );

    // =========================================
    // CREATE CHECKOUT SESSION
    // =========================================
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,

      line_items: [
        {
          // price: "price_1TJAu7BsVpwEk4PVFt7kEy8V",
          price: "price_1TK6VAFHpYhUjYh6OPoXq1gR",
          quantity: 1,
        },
      ],

      subscription_data: {
        trial_period_days: 7,
        metadata: {
          userId: String(userId), // 🔥 FIXED
        },
      },

      success_url: "https://www.auditprorx.com/Mainpage",
      cancel_url: "https://www.auditprorx.com/cancel",
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Stripe session error:", error);
    return res.status(500).json({
      error: "Failed to create checkout session",
    });
  }
});

// =========================================
// CANCEL SUBSCRIPTION
// =========================================
router.post("/cancel-subscription", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: "Missing userId",
      });
    }

    const result = await pool.query(
      `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Subscription not found",
      });
    }

    const subscriptionId = result.rows[0].stripe_subscription_id;

    if (!subscriptionId) {
      return res.status(400).json({
        error: "Subscription not yet created",
      });
    }

    // ✅ Cancel at period end
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return res.json({
      message: "Subscription will cancel at period end",
    });
  } catch (error) {
    console.error("❌ Cancel error:", error);
    return res.status(500).json({
      error: "Failed to cancel subscription",
    });
  }
});

// =========================================
// GET SUBSCRIPTION DETAILS
// =========================================
router.get("/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `
      SELECT 
        stripe_subscription_id,
        stripe_customer_id,
        status,
        current_period_end,
        grace_period_end
      FROM subscriptions
      WHERE user_id = $1
      `,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.json({ subscription: null });
    }

    return res.json({
      subscription: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Fetch error:", err);
    res.status(500).json({
      error: "Failed to fetch subscription",
    });
  }
});

// =========================================
// ADMIN: UPDATE / INSERT SUBSCRIPTION STATUS
// =========================================
router.post("/admin/update-subscription", async (req, res) => {
  try {
    const { userId, status } = req.body;

    // ✅ Validation
    if (!userId || !status) {
      return res.status(400).json({
        error: "Missing userId or status",
      });
    }

    // ✅ Allowed statuses (important for safety)
    const allowedStatuses = [
      "trialing",
      "active",
      "past_due",
      "canceled",
      "inactive",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid status value",
      });
    }

    // =========================================
    // UPSERT (Insert if not exists, else update)
    // =========================================
    const result = await pool.query(
      `
      INSERT INTO subscriptions (user_id, status)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET
        status = EXCLUDED.status
      RETURNING *;
      `,
      [userId, status],
    );

    return res.json({
      message: "Subscription updated successfully",
      subscription: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Admin update error:", error);
    return res.status(500).json({
      error: "Failed to update subscription",
    });
  }
});

export default router;
