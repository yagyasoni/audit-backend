import express from "express";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { Resend } from "resend";

const router = express.Router();

const resend = new Resend(process.env.RESEND_API_KEY);

//
// ============================================================
// CREATE GROUP
// POST /api/audit-share-groups
// ============================================================
//

router.post("/", async (req, res) => {
  try {
    const { name, created_by } = req.body;

    if (!name || !created_by) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    //
    // CREATE GROUP
    //

    const groupResult = await pool.query(
      `
      INSERT INTO audit_share_groups (
        id,
        name,
        created_by
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [crypto.randomUUID(), name, created_by],
    );

    const group = groupResult.rows[0];

    //
    // ADD CREATOR AS ADMIN
    //

    await pool.query(
      `
      INSERT INTO audit_share_group_users (
        id,
        group_id,
        user_id,
        role
      )
      VALUES ($1, $2, $3, 'admin')
      `,
      [crypto.randomUUID(), group.id, created_by],
    );

    res.status(201).json({
      success: true,
      group,
    });
  } catch (err) {
    console.error("Create group error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to create group",
    });
  }
});

//
// ============================================================
// INVITE USER
// POST /api/audit-share-groups/invite
// ============================================================
//

router.post("/invite", async (req, res) => {
  try {
    const { group_id, invited_by, email } = req.body;

    if (!group_id || !invited_by || !email) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    //
    // FIND USER
    //

    const userResult = await pool.query(
      `
      SELECT
        id,
        name,
        email
      FROM users
      WHERE LOWER(email) = LOWER($1)
      `,
      [email],
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const invitedUser = userResult.rows[0];

    //
    // CHECK MEMBER
    //

    const memberResult = await pool.query(
      `
      SELECT id
      FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      `,
      [group_id, invitedUser.id],
    );

    if (memberResult.rowCount > 0) {
      return res.status(400).json({
        success: false,
        message: "User already exists in group",
      });
    }

    //
    // CHECK EXISTING PENDING INVITE
    //

    const inviteCheck = await pool.query(
      `
      SELECT id
      FROM audit_share_group_invites
      WHERE group_id = $1
      AND LOWER(email) = LOWER($2)
      AND status = 'pending'
      `,
      [group_id, email],
    );

    if (inviteCheck.rowCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Invite already sent",
      });
    }

    //
    // CREATE INVITE
    //

    // const inviteResult = await pool.query(
    //   `
    //   INSERT INTO audit_share_group_invites (
    //     id,
    //     group_id,
    //     invited_by,
    //     invited_user_id,
    //     email
    //   )
    //   VALUES ($1, $2, $3, $4, $5)
    //   RETURNING *
    //   `,
    //   [crypto.randomUUID(), group_id, invited_by, invitedUser.id, email],
    // );

    //
    // CREATE INVITE
    //

    const inviteResult = await pool.query(
      `
  INSERT INTO audit_share_group_invites (
    id,
    group_id,
    invited_by,
    invited_user_id,
    email
  )
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (group_id, email)
  DO UPDATE SET
    status = 'pending',
    invited_by = EXCLUDED.invited_by,
    invited_user_id = EXCLUDED.invited_user_id,
    created_at = NOW(),
    accepted_at = NULL
  RETURNING *
  `,
      [crypto.randomUUID(), group_id, invited_by, invitedUser.id, email],
    );

    //
    // GET GROUP
    //

    const groupResult = await pool.query(
      `
      SELECT name
      FROM audit_share_groups
      WHERE id = $1
      `,
      [group_id],
    );

    const groupName = groupResult.rows[0]?.name;

    //
    // GET INVITER (PHARMACY + EMAIL)
    //

    const inviterResult = await pool.query(
      `
      SELECT
        u.email AS inviter_email,
        pd.pharmacy_name AS inviter_pharmacy_name
      FROM users u
      LEFT JOIN pharmacy_details pd ON pd.user_id = u.id
      WHERE u.id = $1
      `,
      [invited_by],
    );

    const inviterEmail = inviterResult.rows[0]?.inviter_email || "";

    const inviterPharmacyName =
      inviterResult.rows[0]?.inviter_pharmacy_name || "A pharmacy";

    //
    // SEND EMAIL
    //

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM,

        to: email,

        subject: `Invitation to join ${groupName}`,

        html: `
  <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden;">

      <!-- Header -->
      <div style="background:#0f172a; color:#ffffff; padding:16px; text-align:center; font-size:18px; font-weight:600;">
        Group Invitation
      </div>

      <!-- Body -->
      <div style="padding:24px; color:#1f2937;">

        <p style="margin-bottom:16px;">
          Hello ${invitedUser.name || "there"},
        </p>

        <p style="margin-bottom:16px;">
          You have been invited to join a group on AuditProRx.
        </p>

        <div style="border:1px solid #e2e8f0; border-radius:8px; padding:18px; margin:20px 0;">

          <h2 style="margin:0 0 10px 0; color:#0f172a;">
            ${groupName}
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
              Audit Sharing Group
            </span>

          </div>

          <!-- Invited By -->
          <div style="margin-top:16px; padding-top:16px; border-top:1px solid #e2e8f0;">
            <p style="margin:0; font-size:12px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#94a3b8;">
              Invited by
            </p>
            <p style="margin:6px 0 0 0; font-size:15px; font-weight:600; color:#0f172a;">
              ${inviterPharmacyName}
            </p>
            <p style="margin:2px 0 0 0; font-size:13px; color:#2563eb;">
              ${inviterEmail}
            </p>
          </div>

        </div>

        <p style="margin-bottom:16px;">
          Please login to your account and accept the invite.
        </p>

        <!-- CTA -->
        <div style="text-align:center; margin:24px 0;">
          
            href="https://www.auditprorx.com/group-reports"
            style="display:inline-block; background:#0f172a; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600;"
          >
            View Invitation
          </a>
        </div>

        <p style="margin:0; font-size:12px; color:#94a3b8; text-align:center; word-break:break-all;">
          Or go to https://www.auditprorx.com/group-reports
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
      });
    } catch (emailErr) {
      console.error("Email error:", emailErr);
    }

    res.status(201).json({
      success: true,
      invite: inviteResult.rows[0],
    });
  } catch (err) {
    console.error("Invite error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to send invite",
    });
  }
});

//
// ============================================================
// ACCEPT INVITE
// POST /api/audit-share-groups/invite/accept
// ============================================================
//

router.post("/invite/accept", async (req, res) => {
  try {
    const { invite_id, user_id } = req.body;

    if (!invite_id || !user_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    //
    // GET INVITE
    //

    const inviteResult = await pool.query(
      `
      SELECT *
      FROM audit_share_group_invites
      WHERE id = $1
      `,
      [invite_id],
    );

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Invite not found",
      });
    }

    const invite = inviteResult.rows[0];

    if (invite.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Invite already processed",
      });
    }

    //
    // ADD MEMBER
    //

    await pool.query(
      `
      INSERT INTO audit_share_group_users (
        id,
        group_id,
        user_id,
        role
      )
      VALUES ($1, $2, $3, 'member')
      `,
      [crypto.randomUUID(), invite.group_id, user_id],
    );

    //
    // UPDATE INVITE
    //

    await pool.query(
      `
      UPDATE audit_share_group_invites
      SET
        status = 'accepted',
        accepted_at = NOW()
      WHERE id = $1
      `,
      [invite_id],
    );

    res.json({
      success: true,
      message: "Invite accepted",
    });
  } catch (err) {
    console.error("Accept invite error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to accept invite",
    });
  }
});

//
// ============================================================
// GET USER GROUPS
// GET /api/audit-share-groups/user/:userId
// ============================================================
//

router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `
      SELECT
        g.*,

        gu.role,

        COUNT(DISTINCT m.user_id)::INTEGER AS members_count,

        COUNT(DISTINCT r.id)::INTEGER AS reports_count

      FROM audit_share_groups g

      JOIN audit_share_group_users gu
      ON gu.group_id = g.id

      LEFT JOIN audit_share_group_users m
      ON m.group_id = g.id

      LEFT JOIN inventory_group_reports r
      ON r.group_id = g.id

      WHERE gu.user_id = $1

      GROUP BY g.id, gu.role

      ORDER BY g.created_at DESC
      `,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Fetch groups error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch groups",
    });
  }
});

//
// ============================================================
// GET PENDING INVITES
// GET /api/audit-share-groups/invites/:userId
// ============================================================
//

router.get("/invites/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // const result = await pool.query(
    //   `
    //   SELECT
    //     i.*,

    //     g.name AS group_name

    //   FROM audit_share_group_invites i

    //   JOIN audit_share_groups g
    //   ON g.id = i.group_id

    //   WHERE i.invited_user_id = $1
    //   AND i.status = 'pending'

    //   ORDER BY i.created_at DESC
    //   `,
    //   [userId],
    // );

    const result = await pool.query(
      `
  SELECT
    i.*,
    g.name AS group_name,
    inviter.email AS inviter_email,
    inviter_pd.pharmacy_name AS inviter_pharmacy_name
  FROM audit_share_group_invites i
  JOIN audit_share_groups g ON g.id = i.group_id
  LEFT JOIN users inviter ON inviter.id = i.invited_by
  LEFT JOIN pharmacy_details inviter_pd ON inviter_pd.user_id = i.invited_by
  WHERE i.invited_user_id = $1 AND i.status = 'pending'
  ORDER BY i.created_at DESC
  `,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Fetch invites error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch invites",
    });
  }
});

//
// ============================================================
// GET GROUP MEMBERS
// GET /api/audit-share-groups/:groupId/members
// ============================================================
//

router.get("/:groupId/members", async (req, res) => {
  try {
    const { groupId } = req.params;

    const result = await pool.query(
      `
      SELECT
        gu.id,
        gu.role,
        gu.joined_at,

        u.id AS user_id,
        u.name,
        u.email,

        pd.pharmacy_name

      FROM audit_share_group_users gu

      JOIN users u
      ON gu.user_id = u.id

      LEFT JOIN pharmacy_details pd
      ON pd.user_id = u.id

      WHERE gu.group_id = $1

      ORDER BY gu.joined_at ASC
      `,
      [groupId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Fetch members error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch members",
    });
  }
});

//
// ============================================================
// REMOVE MEMBER (ADMIN ONLY)
// DELETE /api/audit-groups/:groupId/member/:memberUserId
// ============================================================
//

router.delete("/:groupId/member/:memberUserId", async (req, res) => {
  try {
    const { groupId, memberUserId } = req.params;

    const { current_user_id } = req.body;

    //
    // CHECK ADMIN
    //

    const adminCheck = await pool.query(
      `
      SELECT *
      FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      AND role = 'admin'
      `,
      [groupId, current_user_id],
    );

    if (adminCheck.rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: "Only admins can remove members",
      });
    }

    //
    // PREVENT ADMIN SELF REMOVE
    //

    if (memberUserId === current_user_id) {
      return res.status(400).json({
        success: false,
        message: "Admins cannot remove themselves",
      });
    }

    //
    // REMOVE MEMBER
    //

    await pool.query(
      `
      DELETE FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      `,
      [groupId, memberUserId],
    );

    res.json({
      success: true,
      message: "Member removed successfully",
    });
  } catch (err) {
    console.error("Remove member error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to remove member",
    });
  }
});

//
// ============================================================
// LEAVE GROUP
// DELETE /api/audit-groups/:groupId/leave/:userId
// ============================================================
//

router.delete("/:groupId/leave/:userId", async (req, res) => {
  try {
    const { groupId, userId } = req.params;

    //
    // CHECK MEMBER
    //

    const memberCheck = await pool.query(
      `
      SELECT *
      FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      `,
      [groupId, userId],
    );

    if (memberCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found in group",
      });
    }

    //
    // PREVENT ADMIN LEAVE
    //

    const member = memberCheck.rows[0];

    if (member.role === "admin") {
      return res.status(400).json({
        success: false,
        message: "Admin cannot leave the group",
      });
    }

    //
    // REMOVE MEMBER
    //

    await pool.query(
      `
      DELETE FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      `,
      [groupId, userId],
    );

    res.json({
      success: true,
      message: "Left group successfully",
    });
  } catch (err) {
    console.error("Leave group error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to leave group",
    });
  }
});

//
// ============================================================
// DELETE GROUP (ADMIN ONLY)
// DELETE /api/audit-share-groups/:groupId
// ============================================================
//

router.delete("/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params;

    const { current_user_id } = req.body;

    if (!current_user_id) {
      return res.status(400).json({
        success: false,
        message: "Current user ID is required",
      });
    }

    //
    // CHECK ADMIN ACCESS
    //

    const adminCheck = await pool.query(
      `
      SELECT *
      FROM audit_share_group_users
      WHERE group_id = $1
      AND user_id = $2
      AND role = 'admin'
      `,
      [groupId, current_user_id],
    );

    if (adminCheck.rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: "Only admins can delete the group",
      });
    }

    //
    // DELETE GROUP REPORTS
    //

    await pool.query(
      `
      DELETE FROM inventory_group_reports
      WHERE group_id = $1
      `,
      [groupId],
    );

    //
    // DELETE INVITES
    //

    await pool.query(
      `
      DELETE FROM audit_share_group_invites
      WHERE group_id = $1
      `,
      [groupId],
    );

    //
    // DELETE MEMBERS
    //

    await pool.query(
      `
      DELETE FROM audit_share_group_users
      WHERE group_id = $1
      `,
      [groupId],
    );

    //
    // DELETE GROUP
    //

    await pool.query(
      `
      DELETE FROM audit_share_groups
      WHERE id = $1
      `,
      [groupId],
    );

    res.json({
      success: true,
      message: "Group deleted successfully",
    });
  } catch (err) {
    console.error("Delete group error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to delete group",
    });
  }
});

export default router;
