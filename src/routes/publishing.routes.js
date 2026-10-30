import express from "express";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { Resend } from "resend";
import {
  requireAdmin,
  requireAuth,
  requireAnyAuth,
} from "../middleware/auth.js";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// PUBLISH NOTIFICATION EMAILS
// ------------------------------------------------------------
// REVIEW NOTE: these used to live inline in CREATE POST. They were moved
// here so that CREATE and UPDATE (Draft → Published) send the same email.
//
// What changed in how emails are sent:
//  - Before: one resend.emails.send() per user, all fired at once with
//    Promise.all, and the route waited for all of them before responding.
//    That made publishing slow and could exceed Resend's rate limit
//    (2 requests/second by default), silently dropping some emails.
//  - Now: resend.batch.send() sends up to 100 emails per request, with a
//    short pause between batches to stay under the rate limit. Callers do
//    NOT await this; it runs after the HTTP response has been sent.
//  - The email HTML itself is unchanged.
// ============================================================

const EMAIL_BATCH_SIZE = 100; // Resend batch API maximum per request
const EMAIL_BATCH_DELAY_MS = 600; // pause between batches (< 2 requests/sec)
const MAX_ARTICLE_ID_ATTEMPTS = 5; // see "Article ID with retry" in CREATE POST

// REVIEW NOTE: mobile layout fix. The design is unchanged; only the parts
// that broke on phones were adjusted:
//  - Padding: the outer wrapper (20px), body (24px) and title card (18px)
//    stacked to ~62px per side, leaving ~250px for content on a phone.
//    Reduced to 12px / 20px / 16px.
//  - Badges: Gmail ignores `display:flex` and `gap`, so the two pills had
//    no spacing and their text wrapped ("CATEGORY: / ANNOUNCEMENT"). They
//    are now inline-blocks with margins and `white-space:nowrap`.
//  - Wordmark: "A U D I T P R O R X" (real spaces + 24px letter-spacing)
//    was too wide and pushed the "X" onto its own line. It is now
//    "AUDITPRORX" at 20px with letter-spacing and `white-space:nowrap`.
//  - Title: explicit 20px size and line-height so long titles wrap evenly.
function publishBadgeColors(location) {
  if (location === "New York") return { bg: "#f5f3ff", fg: "#7c3aed" };
  if (location === "New Jersey") return { bg: "#ecfdf5", fg: "#059669" };
  return { bg: "#eff6ff", fg: "#2563eb" };
}

function buildPublishEmailHtml({ name, title, category, location }) {
  const locationColors = publishBadgeColors(location);
  const badgeStyle = `
    display:inline-block;
    margin:0 6px 6px 0;
    padding:6px 12px;
    border-radius:999px;
    font-size:11px;
    font-weight:600;
    letter-spacing:0.5px;
    text-transform:uppercase;
    white-space:nowrap;
  `;

  return `
    <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:12px;">
      <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

        <!-- Header -->
        <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
          New Article Published
        </div>

        <!-- Body -->
        <div style="padding:20px; color:#1f2937; font-size:15px; line-height:1.5;">

          <p style="margin:0 0 16px 0;">
            Hello ${name},
          </p>

          <p style="margin:0 0 16px 0;">
            A new article has been published on the platform.
          </p>

          <div style="border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin:20px 0;">

            <h2 style="margin:0 0 12px 0; color:#0f172a; font-size:20px; line-height:1.3;">
              ${title}
            </h2>

            <div style="font-size:0; line-height:0;">
              <span style="${badgeStyle} background:#eff6ff; color:#2563eb; line-height:1.2;">
                Category: ${category || "General"}
              </span>
              <span style="${badgeStyle} background:${locationColors.bg}; color:${locationColors.fg}; line-height:1.2;">
                Location: ${location || "All"}
              </span>
            </div>

          </div>

          <p style="margin:0 0 16px 0;">
            Login to your account to read the complete article.
          </p>

          <div style="text-align:center; margin-top:28px;">
            <span style="font-size:20px; font-weight:bold; letter-spacing:6px; color:#0f172a; white-space:nowrap;">
              AUDITPRORX
            </span>
          </div>

        </div>

        <!-- Footer -->
        <div style="background:#f1f5f9; padding:16px; font-size:12px; text-align:center; color:#64748b;">
          © 2026 AuditProRx. All rights reserved.
        </div>

      </div>
    </div>
  `;
}

async function sendPublishEmails({ title, category, location }) {
  // REVIEW NOTE: local/dev safety switch. When EMAIL_TEST_TO is set in .env,
  // every publish email goes ONLY to that address and real users are never
  // queried, so testing locally can't email clients. Leave EMAIL_TEST_TO
  // unset in production to email all active users as normal.
  const testRecipient = process.env.EMAIL_TEST_TO?.trim();

  let users;

  if (testRecipient) {
    users = [{ name: "Test User", email: testRecipient }];
  } else {
    const usersResult = await pool.query(
      `
      SELECT name, email
      FROM users
      WHERE status = 'active'
      `,
    );

    users = usersResult.rows;
  }

  for (let i = 0; i < users.length; i += EMAIL_BATCH_SIZE) {
    const batch = users.slice(i, i + EMAIL_BATCH_SIZE);

    const { error } = await resend.batch.send(
      batch.map((user) => ({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: `New Article Published - ${title}`,
        html: buildPublishEmailHtml({
          name: user.name,
          title,
          category,
          location,
        }),
      })),
    );

    // Resend reports failures in `error` rather than throwing, so log it
    // here and carry on with the next batch.
    if (error) {
      console.error(
        `Publish email batch ${i / EMAIL_BATCH_SIZE + 1} failed:`,
        error,
      );
    }

    if (i + EMAIL_BATCH_SIZE < users.length) {
      await new Promise((resolve) => setTimeout(resolve, EMAIL_BATCH_DELAY_MS));
    }
  }
}

// ============================================================
// CREATE POST
// POST /api/publishing/posts
// ============================================================

router.post("/posts", requireAdmin, async (req, res) => {
  try {
    const { title, category, content, status, location } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: "Title and content are required",
      });
    }

    // ── Article ID with retry ────────────────────────────────
    // REVIEW NOTE: article IDs are random (ART-1000 … ART-9999) and
    // publishing_posts.article_id is UNIQUE. Before, a clash made the whole
    // request fail with "Failed to create post". Now, if Postgres rejects the
    // insert with a unique violation (23505) on article_id, we retry with a
    // fresh ID. Any other error, or too many clashes, is thrown as before.
    let result;
    for (let attempt = 1; ; attempt++) {
      const articleId = `ART-${Math.floor(1000 + Math.random() * 9000)}`;

      try {
        result = await pool.query(
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
        break;
      } catch (insertErr) {
        const isArticleIdClash =
          insertErr.code === "23505" &&
          insertErr.constraint?.includes("article_id");

        if (!isArticleIdClash || attempt >= MAX_ARTICLE_ID_ATTEMPTS) {
          throw insertErr;
        }
      }
    }

    // REVIEW NOTE: respond first, email in the background.
    // Before, this route awaited every email before replying, so the admin's
    // "Post" button kept spinning until all users were emailed. Emails now go
    // out after the response (see sendPublishEmails above). We check the
    // saved row's status because status defaults to "Published" when omitted.
    if (result.rows[0].status === "Published") {
      sendPublishEmails(result.rows[0]).catch((emailErr) =>
        console.error("Publish emails failed:", emailErr),
      );
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

router.get("/posts", requireAdmin, async (req, res) => {
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

router.get("/posts/:id", requireAnyAuth, async (req, res) => {
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

router.put("/posts/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { title, category, content, status, location } = req.body;

    // REVIEW NOTE: read the status before updating so we can tell whether
    // this edit publishes a draft (see "Draft → Published" below).
    const before = await pool.query(
      `SELECT status FROM publishing_posts WHERE id = $1`,
      [id],
    );

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

    // ── Draft → Published ───────────────────────────────────
    // REVIEW NOTE: before, users were only emailed when a post was created
    // as Published, so posts that started as drafts never sent an email.
    // Now, if this edit moves a post from Draft to Published, send the same
    // email in the background. Editing an already-published post does NOT
    // email again.
    const wasPublished = before.rows[0]?.status === "Published";

    if (!wasPublished && result.rows[0].status === "Published") {
      sendPublishEmails(result.rows[0]).catch((emailErr) =>
        console.error("Publish emails failed:", emailErr),
      );
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

router.delete("/posts/:id", requireAdmin, async (req, res) => {
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

router.get("/client/posts", requireAnyAuth, async (req, res) => {
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

router.post("/reactions", requireAuth, async (req, res) => {
  try {
    const { post_id, reaction_type } = req.body;
    const user_id = req.user.userId; // from token, not the request body

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

router.post("/responses", requireAuth, async (req, res) => {
  try {
    const { post_id, comment } = req.body;
    const user_id = req.user.userId; // from token, not the request body

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

router.get("/engagement/:postId", requireAnyAuth, async (req, res) => {
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

router.post("/chat/client", requireAuth, async (req, res) => {
  try {
    const { post_id, message } = req.body;
    const user_id = req.user.userId; // from token, not the request body

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

router.post("/chat/admin", requireAdmin, async (req, res) => {
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

router.get("/chat/:postId", requireAnyAuth, async (req, res) => {
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
    // MARK CLIENT MESSAGES AS READ (only when an admin opens the chat)
    // =========================================

    if (req.role === "admin") {
      await pool.query(
        `
        UPDATE publishing_chat_messages
        SET is_read = true
        WHERE post_id = $1
        AND sender_type = 'client'
        `,
        [postId],
      );
    }

    res.json(messages.rows);
  } catch (err) {
    console.error("Get chat error:", err);

    res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch chat messages",
    });
  }
});

router.put("/posts/:id/chat-toggle", requireAdmin, async (req, res) => {
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
