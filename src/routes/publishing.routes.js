import express from "express";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { Resend } from "resend";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// CREATE POST
// POST /api/publishing/posts
// ============================================================

router.post("/posts", async (req, res) => {
  try {
    const { title, category, content, status, location } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: "Title and content are required",
      });
    }

    const articleId = `ART-${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await pool.query(
      `
      INSERT INTO publishing_posts (
        id,
        article_id,
        title,
        category,
        content,
        status,
        location
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        crypto.randomUUID(),
        articleId,
        title,
        category || "General",
        content,
        status || "Published",
        location || "All",
      ],
    );

    const usersResult = await pool.query(
      `
      SELECT name, email
      FROM users
      WHERE status = 'active'
      `,
    );

    const users = usersResult.rows;

    // ============================================================
    // SEND EMAILS
    // ============================================================

    if (users.length > 0) {
      try {
        await Promise.all(
          users.map((user) =>
            resend.emails.send({
              from: process.env.EMAIL_FROM,

              to: user.email,

              subject: `New Article Published - ${title}`,

              html: `
              <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
                <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

                  <!-- Header -->
                  <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
                    New Article Published
                  </div>

                  <!-- Body -->
                  <div style="padding:24px; color:#1f2937;">

                    <p style="margin-bottom:16px;">
                      Hello ${user.name},
                    </p>

                    <p style="margin-bottom:16px;">
                      A new article has been published on the platform.
                    </p>

                    <div style="border:1px solid #e2e8f0; border-radius:8px; padding:18px; margin:20px 0;">

                      <h2 style="margin:0 0 10px 0; color:#0f172a;">
                        ${title}
                      </h2>

                      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">

  <span
    style="
      display:inline-block;
      background:#eff6ff;
      color:#2563eb;
      padding:6px 12px;
      border-radius:999px;
      font-size:12px;
      font-weight:600;
      letter-spacing:0.5px;
      text-transform:uppercase;
    "
  >
    Category: ${category || "General"}
  </span>

  <span
    style="
      display:inline-block;
      background:${
        location === "New York"
          ? "#f5f3ff"
          : location === "New Jersey"
            ? "#ecfdf5"
            : "#eff6ff"
      };
      color:${
        location === "New York"
          ? "#7c3aed"
          : location === "New Jersey"
            ? "#059669"
            : "#2563eb"
      };
      padding:6px 12px;
      border-radius:999px;
      font-size:12px;
      font-weight:600;
      letter-spacing:0.5px;
      text-transform:uppercase;
    "
  >
    Location: ${location || "All"}
  </span>

</div>

                    </div>

                    <p style="margin-bottom:16px;">
                      Login to your account to read the complete article.
                    </p>

                    <div style="text-align:center; margin-top:30px;">
                      <span style="font-size:24px; font-weight:bold; letter-spacing:3px; color:#0f172a;">
                        A U D I T P R O R X
                      </span>
                    </div>

                  </div>

                  <!-- Footer -->
                  <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
                    © 2026 AuditProRx. All rights reserved.
                  </div>

                </div>
              </div>
              `,
            }),
          ),
        );
      } catch (emailErr) {
        console.error("Email sending failed:", emailErr);
      }
    }

    res.status(201).json({
      success: true,
      post: result.rows[0],
    });
  } catch (err) {
    console.error("Create post error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to create post",
    });
  }
});

// ============================================================
// GET ALL POSTS (ADMIN)
// GET /api/publishing/posts
// ============================================================

// router.get("/posts", async (req, res) => {
//   try {
//     const result = await pool.query(
//       `
//       SELECT
//         p.*,

//         COUNT(DISTINCT r.id)::INTEGER AS reactions,
//         COUNT(DISTINCT c.id)::INTEGER AS responses

//       FROM publishing_posts p

//       LEFT JOIN publishing_reactions r
//       ON p.id = r.post_id

//       LEFT JOIN publishing_responses c
//       ON p.id = c.post_id

//       GROUP BY p.id

//       ORDER BY p.created_at DESC
//       `,
//     );

//     res.json(result.rows);
//   } catch (err) {
//     console.error("Fetch posts error:", err);

//     res.status(500).json({
//       success: false,
//       message: "Failed to fetch posts",
//     });
//   }
// });

router.get("/posts", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
          p.*,

          COUNT(DISTINCT r.id)::INTEGER AS reactions,

          COUNT(DISTINCT c.id)::INTEGER AS responses,

          COUNT(
            DISTINCT CASE
              WHEN m.sender_type = 'client'
              AND m.is_read = false
              THEN m.id
            END
          )::INTEGER AS unread_messages

      FROM publishing_posts p

      LEFT JOIN publishing_reactions r
      ON p.id = r.post_id

      LEFT JOIN publishing_responses c
      ON p.id = c.post_id

      LEFT JOIN publishing_chat_messages m
      ON p.id = m.post_id

      GROUP BY p.id

      ORDER BY p.created_at DESC
      `,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Fetch posts error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch posts",
    });
  }
});

// ============================================================
// GET SINGLE POST
// GET /api/publishing/posts/:id
// ============================================================

router.get("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `
      UPDATE publishing_posts
      SET views = views + 1
      WHERE id = $1
      `,
      [id],
    );

    const result = await pool.query(
      `
      SELECT
        p.*,

        COUNT(DISTINCT r.id)::INTEGER AS reactions,
        COUNT(DISTINCT c.id)::INTEGER AS responses

      FROM publishing_posts p

      LEFT JOIN publishing_reactions r
      ON p.id = r.post_id

      LEFT JOIN publishing_responses c
      ON p.id = c.post_id

      WHERE p.id = $1

      GROUP BY p.id
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fetch single post error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch post",
    });
  }
});

// ============================================================
// UPDATE POST
// PUT /api/publishing/posts/:id
// ============================================================

router.put("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { title, category, content, status, location } = req.body;

    const result = await pool.query(
      `
      UPDATE publishing_posts
      SET
        title = $1,
        category = $2,
        content = $3,
        status = $4,
        location = $5,
        updated_at = NOW()

      WHERE id = $6

      RETURNING *
      `,
      [title, category, content, status, location, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json({
      success: true,
      post: result.rows[0],
    });
  } catch (err) {
    console.error("Update post error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to update post",
    });
  }
});

// ============================================================
// DELETE POST
// DELETE /api/publishing/posts/:id
// ============================================================

router.delete("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM publishing_posts
      WHERE id = $1
      RETURNING *
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json({
      success: true,
      message: "Post deleted successfully",
    });
  } catch (err) {
    console.error("Delete post error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to delete post",
    });
  }
});

// ============================================================
// CLIENT SIDE POSTS
// ONLY PUBLISHED POSTS
// GET /api/publishing/client/posts
// ============================================================

router.get("/client/posts", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        p.*,

        COUNT(DISTINCT r.id)::INTEGER AS reactions,
        COUNT(DISTINCT c.id)::INTEGER AS responses

      FROM publishing_posts p

      LEFT JOIN publishing_reactions r
      ON p.id = r.post_id

      LEFT JOIN publishing_responses c
      ON p.id = c.post_id

      WHERE p.status = 'Published'

      GROUP BY p.id

      ORDER BY p.created_at DESC
      `,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Client posts error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch client posts",
    });
  }
});

// ============================================================
// ADD REACTION
// POST /api/publishing/reactions
// ============================================================

router.post("/reactions", async (req, res) => {
  try {
    const { post_id, user_id, reaction_type } = req.body;

    if (!post_id || !user_id || !reaction_type) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM publishing_reactions
      WHERE post_id = $1
      AND user_id = $2
      `,
      [post_id, user_id],
    );

    if (existing.rowCount > 0) {
      await pool.query(
        `
        UPDATE publishing_reactions
        SET reaction_type = $1
        WHERE post_id = $2
        AND user_id = $3
        `,
        [reaction_type, post_id, user_id],
      );

      return res.json({
        success: true,
        message: "Reaction updated",
      });
    }

    await pool.query(
      `
      INSERT INTO publishing_reactions (
        id,
        post_id,
        user_id,
        reaction_type
      )
      VALUES ($1, $2, $3, $4)
      `,
      [crypto.randomUUID(), post_id, user_id, reaction_type],
    );

    res.json({
      success: true,
      message: "Reaction added",
    });
  } catch (err) {
    console.error("Reaction error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to react",
    });
  }
});

// ============================================================
// ADD RESPONSE / COMMENT
// POST /api/publishing/responses
// ============================================================

router.post("/responses", async (req, res) => {
  try {
    const { post_id, user_id, comment } = req.body;

    if (!post_id || !user_id || !comment) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO publishing_responses (
        id,
        post_id,
        user_id,
        comment
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [crypto.randomUUID(), post_id, user_id, comment],
    );

    res.status(201).json({
      success: true,
      response: result.rows[0],
    });
  } catch (err) {
    console.error("Response error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to add response",
    });
  }
});

// ============================================================
// GET ENGAGEMENT
// GET /api/publishing/engagement/:postId
// ============================================================

router.get("/engagement/:postId", async (req, res) => {
  try {
    const { postId } = req.params;

    const reactions = await pool.query(
      `
      SELECT
        r.id,
        r.reaction_type,
        r.created_at,
        u.name AS user_name

      FROM publishing_reactions r

      JOIN users u
      ON r.user_id = u.id

      WHERE r.post_id = $1

      ORDER BY r.created_at DESC
      `,
      [postId],
    );

    const responses = await pool.query(
      `
      SELECT
        c.id,
        c.comment,
        c.created_at,
        u.name AS user_name

      FROM publishing_responses c

      JOIN users u
      ON c.user_id = u.id

      WHERE c.post_id = $1

      ORDER BY c.created_at DESC
      `,
      [postId],
    );

    res.json({
      reactions: reactions.rows,
      responses: responses.rows,
    });
  } catch (err) {
    console.error("Engagement error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch engagement",
    });
  }
});

router.post("/chat/client", async (req, res) => {
  try {
    const { post_id, user_id, message } = req.body;

    if (!post_id || !user_id || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // =========================================
    // CHECK CHAT ENABLED
    // =========================================

    const post = await pool.query(
      `
      SELECT chat_enabled
      FROM publishing_posts
      WHERE id = $1
      `,
      [post_id],
    );

    if (post.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    if (!post.rows[0].chat_enabled) {
      return res.status(403).json({
        success: false,
        message: "Chat disabled",
      });
    }

    // =========================================
    // BAD WORD FILTER
    // =========================================

    // return res.status(400).json({
    //   success: false,
    //   message: "Message contains inappropriate language",
    // });

    // =========================================
    // SAVE MESSAGE
    // =========================================

    const result = await pool.query(
      `
      INSERT INTO publishing_chat_messages (
        id,
        post_id,
        user_id,
        sender_type,
        message
      )
      VALUES (
        $1,
        $2,
        $3,
        'client',
        $4
      )
      RETURNING *
      `,
      [crypto.randomUUID(), post_id, user_id, message],
    );

    res.status(201).json({
      success: true,
      chat: result.rows[0],
    });
  } catch (err) {
    console.error("Client chat error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
});

router.post("/chat/admin", async (req, res) => {
  try {
    const { post_id, message } = req.body;

    if (!post_id || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO publishing_chat_messages (
        id,
        post_id,
        sender_type,
        message,
        is_read
      )
      VALUES (
        $1,
        $2,
        'admin',
        $3,
        true
      )
      RETURNING *
      `,
      [crypto.randomUUID(), post_id, message],
    );

    res.json({
      success: true,
      chat: result.rows[0],
    });
  } catch (err) {
    console.error("Admin chat error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to send admin message",
    });
  }
});

router.get("/chat/:postId", async (req, res) => {
  try {
    const { postId } = req.params;

    // const messages = await pool.query(
    //   `
    //   SELECT
    //     id,
    //     sender_type,
    //     message,
    //     is_read,
    //     created_at

    //   FROM publishing_chat_messages

    //   WHERE post_id = $1

    //   ORDER BY created_at ASC
    //   `,
    //   [postId],
    // );

    const messages = await pool.query(
      `
  SELECT
    m.id,
    m.sender_type,
    m.message,
    m.is_read,
    m.created_at,

    u.name AS user_name,

    pd.pharmacy_name

  FROM publishing_chat_messages m

  LEFT JOIN users u
  ON m.user_id = u.id

  LEFT JOIN pharmacy_details pd
  ON pd.user_id = u.id

  WHERE m.post_id = $1

  ORDER BY m.created_at ASC
  `,
      [postId],
    );

    // =========================================
    // MARK CLIENT MESSAGES AS READ
    // =========================================

    await pool.query(
      `
      UPDATE publishing_chat_messages
      SET is_read = true
      WHERE post_id = $1
      AND sender_type = 'client'
      `,
      [postId],
    );

    res.json(messages.rows);
  } catch (err) {
    console.error("Get chat error:", err);

    res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch chat messages",
    });
  }
});

router.put("/posts/:id/chat-toggle", async (req, res) => {
  try {
    const { id } = req.params;

    const { chat_enabled } = req.body;

    const result = await pool.query(
      `UPDATE publishing_posts
SET chat_enabled = $1
WHERE id = $2
RETURNING *
      `,
      [chat_enabled, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json({
      success: true,
      post: result.rows[0],
    });
  } catch (err) {
    console.error("Toggle chat error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to update chat setting",
    });
  }
});

export default router;
