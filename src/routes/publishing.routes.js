import express from "express";
import crypto from "crypto";
import { pool } from "../config/db.js";

const router = express.Router();

// ============================================================
// CREATE POST
// POST /api/publishing/posts
// ============================================================

router.post("/posts", async (req, res) => {
  try {
    const { title, category, content, status } = req.body;

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
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        crypto.randomUUID(),
        articleId,
        title,
        category || "General",
        content,
        status || "Published",
      ],
    );

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

router.get("/posts", async (req, res) => {
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

    const { title, category, content, status } = req.body;

    const result = await pool.query(
      `
      UPDATE publishing_posts
      SET
        title = $1,
        category = $2,
        content = $3,
        status = $4,
        updated_at = NOW()

      WHERE id = $5

      RETURNING *
      `,
      [title, category, content, status, id],
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

export default router;
