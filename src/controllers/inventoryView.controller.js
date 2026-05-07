// import jwt from "jsonwebtoken";
// import { pool } from "../config/db.js";
// import {
//   sendConnectRequestEmail,
//   sendGroupInvitationEmail,
// } from "../services/inventoryViewEmail.service.js";

// // ── Helpers ────────────────────────────────────────────────────────────────

// const requireUser = (req) => {
//   const auth = req.headers.authorization;
//   if (!auth)
//     throw Object.assign(new Error("Authorization header missing"), {
//       status: 401,
//     });
//   const token = auth.split(" ")[1];
//   if (!token) throw Object.assign(new Error("Token missing"), { status: 401 });
//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     return decoded.userId;
//   } catch (e) {
//     throw Object.assign(new Error("jwt expired"), { status: 401 });
//   }
// };

// const getUserPharmacyId = async (userId) => {
//   const r = await pool.query(
//     `SELECT id FROM pharmacy_details WHERE user_id = $1 LIMIT 1`,
//     [userId]
//   );
//   return r.rows[0]?.id || null;
// };

// const generateInviteCode = (groupName) => {
//   const prefix = (groupName || "GROUP")
//     .replace(/[^A-Za-z0-9]/g, "")
//     .toUpperCase()
//     .slice(0, 8) || "GROUP";
//   const segment = () => {
//     const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
//     let s = "";
//     for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
//     return s;
//   };
//   return `${prefix}-${segment()}-${segment()}`;
// };

// const mapListingRow = (r) => ({
//   id: r.id,
//   ndc: r.ndc,
//   drug_name: r.drug_name,
//   strength: r.strength,
//   dosage_form: r.dosage_form,
//   manufacturer: r.manufacturer,
//   package_size: r.package_size,
//   quantity: r.quantity,
//   lot_number: r.lot_number,
//   expiry: r.expiry,
//   acquisition_cost: r.acquisition_cost ? parseFloat(r.acquisition_cost) : null,
//   reason_code: r.reason_code,
//   visibility: r.visibility || "public",
//   group_ids: r.group_ids || [],
//   pharmacy: {
//     id: r.pharmacy_id,
//     pharmacy_name: r.pharmacy_name,
//     address: r.address,
//     phone: r.phone,
//     fax: r.fax,
//     email: r.pharmacy_email,
//     npi_number: r.npi_number,
//     ncpdp_number: r.ncpdp_number,
//     license_expiry_date: r.license_expiry_date,
//     pharmacist_name: r.pharmacist_name,
//     member_since: r.pharmacy_member_since,
//     rating: 5.0,
//     total_transfers: 0,
//     last_active: null,
//   },
//   distance_miles: null,
//   listed_at: r.listed_at,
//   owner_user_id: r.owner_user_id,
// });

// // ============================================================================
// // LISTINGS — updated with visibility filtering
// // ============================================================================

// export const getListings = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const myPharmacyId = await getUserPharmacyId(userId);

//     // Find groups the user's pharmacy is in
//     let memberGroupIds = [];
//     if (myPharmacyId) {
//       const groupsRes = await pool.query(
//         `SELECT group_id FROM inventory_group_members WHERE pharmacy_id = $1`,
//         [myPharmacyId]
//       );
//       memberGroupIds = groupsRes.rows.map((g) => g.group_id);
//     }

//     // Listings are visible if:
//     //   - Owned by current user, OR
//     //   - visibility = 'public', OR
//     //   - visibility = 'groups_only' AND listing is shared with at least one
//     //     group the current pharmacy is a member of
//     const result = await pool.query(
//       `
//       SELECT
//         l.id, l.ndc, l.drug_name, l.strength, l.dosage_form, l.manufacturer,
//         l.package_size, l.quantity, l.lot_number, l.expiry, l.acquisition_cost,
//         l.reason_code, l.visibility,
//         l.created_at AS listed_at,
//         l.user_id AS owner_user_id,
//         p.id AS pharmacy_id, p.pharmacy_name, p.address, p.phone, p.fax,
//         p.npi_number, p.ncpdp_number, p.license_expiry_date,
//         p.pharmacist_name, p.created_at AS pharmacy_member_since,
//         u.email AS pharmacy_email,
//         COALESCE(
//           ARRAY(SELECT group_id FROM inventory_listing_groups WHERE listing_id = l.id),
//           ARRAY[]::uuid[]
//         ) AS group_ids
//       FROM inventory_listings l
//       LEFT JOIN pharmacy_details p ON p.id = l.pharmacy_id
//       LEFT JOIN users u ON u.id = l.user_id
//       WHERE l.is_active = true
//         AND (l.auto_expires_at IS NULL OR l.auto_expires_at > NOW())
//         AND (
//           l.user_id = $1
//           OR l.visibility = 'public'
//           OR (
//             l.visibility = 'groups_only'
//             AND EXISTS (
//               SELECT 1 FROM inventory_listing_groups lg
//               WHERE lg.listing_id = l.id
//                 AND lg.group_id = ANY($2::uuid[])
//             )
//           )
//         )
//       ORDER BY l.created_at DESC
//       `,
//       [userId, memberGroupIds.length ? memberGroupIds : [null]]
//     );

//     const all = result.rows.map(mapListingRow);
//     const listings = all.filter((l) => l.owner_user_id !== userId);
//     const my_listings = all.filter((l) => l.owner_user_id === userId);

//     return res.json({ listings, my_listings });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("getListings error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// export const createListing = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const {
//       ndc, drug_name, strength, dosage_form, manufacturer, package_size,
//       lot_number, expiry, quantity, acquisition_cost, reason_code,
//       visibility = "public",
//       group_ids = [],
//     } = req.body;

//     if (!ndc || !drug_name || !lot_number || !expiry || !quantity || !reason_code) {
//       return res.status(400).json({ error: "Missing required fields" });
//     }

//     const pharmacyId = await getUserPharmacyId(userId);
//     if (!pharmacyId) {
//       return res.status(400).json({ error: "No pharmacy registered for this user" });
//     }

//     const finalVisibility =
//       visibility === "groups_only" && Array.isArray(group_ids) && group_ids.length > 0
//         ? "groups_only"
//         : "public";

//     const result = await pool.query(
//       `INSERT INTO inventory_listings
//         (user_id, pharmacy_id, ndc, drug_name, strength, dosage_form,
//          manufacturer, package_size, quantity, lot_number, expiry,
//          acquisition_cost, reason_code, visibility, is_active, auto_expires_at)
//        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW() + INTERVAL '30 days')
//        RETURNING *`,
//       [
//         userId, pharmacyId, ndc, drug_name,
//         strength || null, dosage_form || null, manufacturer || null, package_size || null,
//         parseInt(quantity, 10), lot_number, expiry,
//         acquisition_cost ? parseFloat(acquisition_cost) : null,
//         reason_code, finalVisibility,
//       ]
//     );
//     const listing = result.rows[0];

//     // Wire up group visibility
//     if (finalVisibility === "groups_only" && group_ids.length > 0) {
//       // Verify each group_id is one the user is actually a member of
//       const validGroups = await pool.query(
//         `SELECT group_id FROM inventory_group_members
//          WHERE pharmacy_id = $1 AND group_id = ANY($2::uuid[])`,
//         [pharmacyId, group_ids]
//       );
//       const validGroupIds = validGroups.rows.map((g) => g.group_id);

//       for (const gid of validGroupIds) {
//         await pool.query(
//           `INSERT INTO inventory_listing_groups (listing_id, group_id)
//            VALUES ($1, $2) ON CONFLICT DO NOTHING`,
//           [listing.id, gid]
//         );
//       }
//     }

//     return res.status(201).json(listing);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("createListing error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// export const updateListing = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id } = req.params;
//     const { quantity, expiry, acquisition_cost, reason_code, visibility, group_ids } = req.body;

//     const ownerCheck = await pool.query(
//       `SELECT user_id FROM inventory_listings WHERE id = $1`, [id]
//     );
//     if (ownerCheck.rows.length === 0)
//       return res.status(404).json({ error: "Listing not found" });
//     if (ownerCheck.rows[0].user_id !== userId)
//       return res.status(403).json({ error: "Not authorized to update this listing" });

//     const sets = [];
//     const params = [];
//     let p = 1;

//     if (quantity !== undefined) {
//       const q = parseInt(quantity, 10);
//       if (isNaN(q) || q < 1) return res.status(400).json({ error: "Quantity must be a positive integer" });
//       sets.push(`quantity = $${p++}`); params.push(q);
//     }
//     if (expiry !== undefined) { sets.push(`expiry = $${p++}`); params.push(expiry || null); }
//     if (acquisition_cost !== undefined) {
//       sets.push(`acquisition_cost = $${p++}`);
//       params.push(acquisition_cost ? parseFloat(acquisition_cost) : null);
//     }
//     if (reason_code !== undefined) { sets.push(`reason_code = $${p++}`); params.push(reason_code); }
//     if (visibility !== undefined) {
//       const v = visibility === "groups_only" ? "groups_only" : "public";
//       sets.push(`visibility = $${p++}`); params.push(v);
//     }

//     if (sets.length === 0 && group_ids === undefined)
//       return res.status(400).json({ error: "No fields to update" });

//     if (sets.length > 0) {
//       sets.push(`updated_at = NOW()`);
//       params.push(id);
//       await pool.query(
//         `UPDATE inventory_listings SET ${sets.join(", ")} WHERE id = $${p}`,
//         params
//       );
//     }

//     // Replace group associations if group_ids was provided
//     if (Array.isArray(group_ids)) {
//       const pharmacyId = await getUserPharmacyId(userId);
//       await pool.query(`DELETE FROM inventory_listing_groups WHERE listing_id = $1`, [id]);
//       if (group_ids.length > 0) {
//         const validGroups = await pool.query(
//           `SELECT group_id FROM inventory_group_members
//            WHERE pharmacy_id = $1 AND group_id = ANY($2::uuid[])`,
//           [pharmacyId, group_ids]
//         );
//         for (const g of validGroups.rows) {
//           await pool.query(
//             `INSERT INTO inventory_listing_groups (listing_id, group_id)
//              VALUES ($1, $2) ON CONFLICT DO NOTHING`,
//             [id, g.group_id]
//           );
//         }
//       }
//     }

//     const updated = await pool.query(`SELECT * FROM inventory_listings WHERE id = $1`, [id]);
//     return res.json(updated.rows[0]);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("updateListing error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// export const deleteListing = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id } = req.params;

//     const ownerCheck = await pool.query(
//       `SELECT user_id FROM inventory_listings WHERE id = $1`, [id]
//     );
//     if (ownerCheck.rows.length === 0)
//       return res.status(404).json({ error: "Listing not found" });
//     if (ownerCheck.rows[0].user_id !== userId)
//       return res.status(403).json({ error: "Not authorized to delete this listing" });

//     await pool.query(
//       `UPDATE inventory_listings SET is_active = false, updated_at = NOW() WHERE id = $1`,
//       [id]
//     );

//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("deleteListing error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // REPORT — unchanged
// // ============================================================================

// export const reportListing = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id: listingId } = req.params;
//     const { reason_code, details } = req.body;

//     if (!reason_code) return res.status(400).json({ error: "Reason is required" });

//     await pool.query(`
//       CREATE TABLE IF NOT EXISTS inventory_listing_reports (
//         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//         listing_id UUID,
//         reporter_user_id UUID NOT NULL,
//         reason_code TEXT NOT NULL,
//         details TEXT,
//         status TEXT DEFAULT 'open',
//         reviewed_by UUID,
//         reviewed_at TIMESTAMP,
//         created_at TIMESTAMP DEFAULT NOW()
//       );
//     `);

//     const listingCheck = await pool.query(
//       `SELECT id FROM inventory_listings WHERE id = $1`, [listingId]
//     );
//     if (listingCheck.rows.length === 0)
//       return res.status(404).json({ error: "Listing not found" });

//     const result = await pool.query(
//       `INSERT INTO inventory_listing_reports
//         (listing_id, reporter_user_id, reason_code, details)
//        VALUES ($1, $2, $3, $4)
//        RETURNING id, created_at`,
//       [listingId, userId, reason_code, details || null]
//     );

//     return res.status(201).json({ ok: true, report_id: result.rows[0].id });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("reportListing error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // AGREEMENT — unchanged
// // ============================================================================

// export const getAgreementStatus = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const result = await pool.query(
//       `SELECT id, accepted_at, agreement_version
//        FROM inventory_agreement_acceptances
//        WHERE user_id = $1
//        ORDER BY accepted_at DESC LIMIT 1`,
//       [userId]
//     );
//     return res.json({
//       accepted: result.rows.length > 0,
//       accepted_at: result.rows[0]?.accepted_at || null,
//       version: result.rows[0]?.agreement_version || null,
//     });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("getAgreementStatus error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// export const acceptAgreement = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { version } = req.body;
//     const ip =
//       req.headers["x-forwarded-for"]?.split(",")[0] ||
//       req.socket?.remoteAddress || null;
//     const ua = req.headers["user-agent"] || null;
//     const pharmacyId = await getUserPharmacyId(userId);

//     await pool.query(
//       `INSERT INTO inventory_agreement_acceptances
//         (user_id, pharmacy_id, agreement_version, ip_address, user_agent)
//        VALUES ($1, $2, $3, $4, $5)
//        ON CONFLICT (user_id, agreement_version) DO NOTHING`,
//       [userId, pharmacyId, version || "1.0", ip, ua]
//     );
//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("acceptAgreement error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // CONNECT REQUEST — unchanged
// // ============================================================================

// export const sendConnectRequest = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const {
//       listing_id, seller_pharmacy_id, seller_email, patient_rx,
//       quantity, notes, email_subject, email_body,
//     } = req.body;

//     if (!listing_id || !seller_email || !email_subject || !email_body)
//       return res.status(400).json({ error: "Missing required fields" });

//     const buyerPharmacyId = await getUserPharmacyId(userId);

//     const sellerUserRes = await pool.query(
//       `SELECT user_id FROM inventory_listings WHERE id = $1`, [listing_id]
//     );
//     const sellerUserId = sellerUserRes.rows[0]?.user_id || null;

//     const buyerInfoRes = await pool.query(
//       `SELECT name, email FROM users WHERE id = $1 LIMIT 1`, [userId]
//     );
//     const buyerName = buyerInfoRes.rows[0]?.name || null;
//     const buyerEmail = buyerInfoRes.rows[0]?.email || null;

//     const insertRes = await pool.query(
//       `INSERT INTO inventory_connect_requests
//         (listing_id, buyer_user_id, buyer_pharmacy_id,
//          seller_user_id, seller_pharmacy_id, seller_email,
//          patient_rx, quantity, notes,
//          email_subject, email_body, status)
//        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
//        RETURNING id`,
//       [
//         listing_id, userId, buyerPharmacyId, sellerUserId,
//         seller_pharmacy_id, seller_email, patient_rx,
//         parseInt(quantity, 10), notes, email_subject, email_body,
//       ]
//     );
//     const requestId = insertRes.rows[0].id;

//     let messageId = null;
//     let status = "sent";
//     let emailError = null;
//     try {
//       const result = await sendConnectRequestEmail({
//         to: seller_email, subject: email_subject, body: email_body,
//         buyerName, buyerEmail,
//       });
//       messageId = result?.messageId || null;
//     } catch (mailErr) {
//       console.error("Email send failed:", mailErr);
//       status = "failed";
//       emailError = mailErr.message;
//     }

//     await pool.query(
//       `UPDATE inventory_connect_requests
//        SET status = $1, email_sent_at = NOW(), email_message_id = $2, updated_at = NOW()
//        WHERE id = $3`,
//       [status, messageId, requestId]
//     );

//     return res.json({ ok: status === "sent", request_id: requestId, status, email_error: emailError });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("sendConnectRequest error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // GROUPS — new endpoints
// // ============================================================================

// // GET /groups — list all groups I'm in
// export const getMyGroups = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     if (!pharmacyId) return res.json([]);

//     const result = await pool.query(
//       `SELECT
//          g.id, g.name, g.description, g.max_members, g.created_at,
//          g.created_by_user_id,
//          m.role,
//          (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = g.id) AS member_count,
//          (g.created_by_user_id = $1) AS is_admin
//        FROM inventory_groups g
//        JOIN inventory_group_members m ON m.group_id = g.id
//        WHERE m.pharmacy_id = $2
//          AND g.is_active = true
//        ORDER BY g.created_at DESC`,
//       [userId, pharmacyId]
//     );

//     return res.json(result.rows.map((r) => ({
//       ...r,
//       member_count: Number(r.member_count),
//     })));
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("getMyGroups error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /groups — create new group
// export const createGroup = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     if (!pharmacyId)
//       return res.status(400).json({ error: "No pharmacy registered for this user" });

//     const { name, description } = req.body;
//     if (!name || !name.trim())
//       return res.status(400).json({ error: "Group name is required" });

//     // Cap at 5 groups per pharmacy
//     // Cap at 5 ACTIVE groups per pharmacy
// const countRes = await pool.query(
//   `SELECT COUNT(*) FROM inventory_group_members m
//    JOIN inventory_groups g ON g.id = m.group_id
//    WHERE m.pharmacy_id = $1 AND g.is_active = true`,
//   [pharmacyId]
// );
// if (Number(countRes.rows[0].count) >= 5)
//   return res.status(400).json({ error: "You can be in at most 5 groups." });

//     const groupRes = await pool.query(
//       `INSERT INTO inventory_groups
//         (name, description, created_by_user_id, created_by_pharmacy_id)
//        VALUES ($1, $2, $3, $4)
//        RETURNING *`,
//       [name.trim(), description || null, userId, pharmacyId]
//     );
//     const group = groupRes.rows[0];

//     // Add creator as admin member
//     await pool.query(
//       `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
//        VALUES ($1, $2, $3, 'admin')`,
//       [group.id, pharmacyId, userId]
//     );

//     return res.status(201).json(group);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("createGroup error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // GET /groups/:id — group details + members
// export const getGroupDetail = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     const { id } = req.params;

//     // Verify membership
//     const memCheck = await pool.query(
//       `SELECT 1 FROM inventory_group_members WHERE group_id = $1 AND pharmacy_id = $2`,
//       [id, pharmacyId]
//     );
//     if (memCheck.rows.length === 0)
//       return res.status(403).json({ error: "Not a member of this group" });

//     const groupRes = await pool.query(
//       `SELECT g.*, (g.created_by_user_id = $1) AS is_admin
//        FROM inventory_groups g WHERE g.id = $2 AND g.is_active = true`,
//       [userId, id]
//     );
//     if (groupRes.rows.length === 0)
//       return res.status(404).json({ error: "Group not found" });
//     const group = groupRes.rows[0];

//     const membersRes = await pool.query(
//       `SELECT
//          m.id, m.role, m.joined_at,
//          m.pharmacy_id, m.user_id,
//          p.pharmacy_name, p.address, p.npi_number, p.ncpdp_number, p.phone,
//          u.name AS user_name, u.email AS user_email
//        FROM inventory_group_members m
//        LEFT JOIN pharmacy_details p ON p.id = m.pharmacy_id
//        LEFT JOIN users u ON u.id = m.user_id
//        WHERE m.group_id = $1
//        ORDER BY m.role DESC, m.joined_at ASC`,
//       [id]
//     );

//     const codesRes = await pool.query(
//       `SELECT id, code, max_uses, uses_count, expires_at, created_at, is_active
//        FROM inventory_group_invite_codes
//        WHERE group_id = $1 AND is_active = true AND expires_at > NOW()
//        ORDER BY created_at DESC`,
//       [id]
//     );

//     const invitesRes = await pool.query(
//       `SELECT
//          i.id, i.invited_email, i.status, i.created_at, i.expires_at,
//          p.pharmacy_name AS invited_pharmacy_name,
//          u.email AS invited_user_email
//        FROM inventory_group_invitations i
//        LEFT JOIN pharmacy_details p ON p.id = i.invited_pharmacy_id
//        LEFT JOIN users u ON u.id = i.invited_user_id
//        WHERE i.group_id = $1 AND i.status = 'pending'
//        ORDER BY i.created_at DESC`,
//       [id]
//     );

//     return res.json({
//       group,
//       members: membersRes.rows,
//       invite_codes: codesRes.rows,
//       pending_invitations: invitesRes.rows,
//     });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("getGroupDetail error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /groups/:id/invite — invite by pharmacy_id OR email (admin only)
// export const inviteToGroup = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id: groupId } = req.params;
//     const { pharmacy_id, email, message } = req.body;

//     // Verify admin
//     const adminCheck = await pool.query(
//       `SELECT 1 FROM inventory_groups WHERE id = $1 AND created_by_user_id = $2`,
//       [groupId, userId]
//     );
//     if (adminCheck.rows.length === 0)
//       return res.status(403).json({ error: "Only the group admin can invite members" });

//     // Check group exists + capacity
//     const groupRes = await pool.query(
//       `SELECT name, max_members,
//          (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = $1) AS member_count
//        FROM inventory_groups WHERE id = $1`,
//       [groupId]
//     );
//     if (groupRes.rows.length === 0)
//       return res.status(404).json({ error: "Group not found" });
//     const group = groupRes.rows[0];
//     if (Number(group.member_count) >= group.max_members)
//       return res.status(400).json({ error: "Group is at maximum capacity" });

//     let invitedPharmacyId = pharmacy_id || null;
//     let invitedUserId = null;
//     let invitedEmail = email || null;

//     // Resolve pharmacy → user
//     if (invitedPharmacyId) {
//       const userRes = await pool.query(
//         `SELECT user_id FROM pharmacy_details WHERE id = $1`,
//         [invitedPharmacyId]
//       );
//       if (userRes.rows.length === 0)
//         return res.status(404).json({ error: "Pharmacy not found" });
//       invitedUserId = userRes.rows[0].user_id;
//       const userInfo = await pool.query(
//         `SELECT email FROM users WHERE id = $1`, [invitedUserId]
//       );
//       invitedEmail = userInfo.rows[0]?.email || invitedEmail;
//     } else if (invitedEmail) {
//       // Email path — try to resolve to a registered user
//       const userRes = await pool.query(
//         `SELECT u.id, p.id AS pharmacy_id
//          FROM users u
//          LEFT JOIN pharmacy_details p ON p.user_id = u.id
//          WHERE LOWER(u.email) = LOWER($1) LIMIT 1`,
//         [invitedEmail]
//       );
//       if (userRes.rows.length > 0) {
//         invitedUserId = userRes.rows[0].id;
//         invitedPharmacyId = userRes.rows[0].pharmacy_id;
//       }
//     } else {
//       return res.status(400).json({ error: "Provide either pharmacy_id or email" });
//     }

//     // Check duplicates
//     if (invitedPharmacyId) {
//       const dup = await pool.query(
//         `SELECT 1 FROM inventory_group_members
//          WHERE group_id = $1 AND pharmacy_id = $2`,
//         [groupId, invitedPharmacyId]
//       );
//       if (dup.rows.length > 0)
//         return res.status(400).json({ error: "This pharmacy is already a member" });
//     }
//     const dupInv = await pool.query(
//       `SELECT 1 FROM inventory_group_invitations
//        WHERE group_id = $1 AND status = 'pending'
//          AND (invited_pharmacy_id = $2 OR (invited_email IS NOT NULL AND LOWER(invited_email) = LOWER($3)))`,
//       [groupId, invitedPharmacyId, invitedEmail]
//     );
//     if (dupInv.rows.length > 0)
//       return res.status(400).json({ error: "An invitation is already pending for this pharmacy/email" });

//     // Insert invitation
//     const inv = await pool.query(
//       `INSERT INTO inventory_group_invitations
//         (group_id, invited_email, invited_user_id, invited_pharmacy_id,
//          invited_by_user_id, message)
//        VALUES ($1, $2, $3, $4, $5, $6)
//        RETURNING *`,
//       [groupId, invitedEmail || null, invitedUserId, invitedPharmacyId, userId, message || null]
//     );

//     // Send invite email (best-effort)

//     // if (invitedEmail) {
//     //   try {
//     //     const inviterRes = await pool.query(
//     //       `SELECT u.name, p.pharmacy_name
//     //        FROM users u
//     //        LEFT JOIN pharmacy_details p ON p.user_id = u.id
//     //        WHERE u.id = $1`,
//     //       [userId]
//     //     );
//     //     const inviter = inviterRes.rows[0] || {};
//     //     await sendGroupInvitationEmail({
//     //       to: invitedEmail,
//     //       groupName: group.name,
//     //       inviterName: inviter.name || "A pharmacy",
//     //       inviterPharmacy: inviter.pharmacy_name || "",
//     //       message: message || null,
//     //     });
//     //   } catch (mailErr) {
//     //     console.warn("Group invitation email failed (non-fatal):", mailErr.message);
//     //   }
//     // }

//     // Send invite email (best-effort)
//     console.log("📨 EMAIL DEBUG — invitedEmail value:", invitedEmail);
//     console.log("📨 EMAIL DEBUG — typeof invitedEmail:", typeof invitedEmail);
//     console.log("📨 EMAIL DEBUG — group name:", group.name);

//     if (invitedEmail) {
//       console.log("✅ Entering email send block");
//       try {
//         const inviterRes = await pool.query(
//           `SELECT u.name, p.pharmacy_name
//            FROM users u
//            LEFT JOIN pharmacy_details p ON p.user_id = u.id
//            WHERE u.id = $1`,
//           [userId]
//         );
//         const inviter = inviterRes.rows[0] || {};
//         console.log("📨 Calling sendGroupInvitationEmail with:");
//         console.log("   to:", invitedEmail);
//         console.log("   groupName:", group.name);
//         console.log("   inviterName:", inviter.name || "A pharmacy");
//         console.log("   inviterPharmacy:", inviter.pharmacy_name || "");

//         const result = await sendGroupInvitationEmail({
//           to: invitedEmail,
//           groupName: group.name,
//           inviterName: inviter.name || "A pharmacy",
//           inviterPharmacy: inviter.pharmacy_name || "",
//           message: message || null,
//         });
//         console.log("✅ Email sent successfully, messageId:", result?.messageId);
//       } catch (mailErr) {
//         console.error("❌❌❌ GROUP INVITATION EMAIL FAILED ❌❌❌");
//         console.error("Error message:", mailErr.message);
//         console.error("Full error:", mailErr);
//       }
//     } else {
//       console.log("⚠️ Skipped email — invitedEmail is falsy");
//     }

//     return res.status(201).json({ ok: true, invitation: inv.rows[0] });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("inviteToGroup error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /groups/:id/invite-code — generate shareable code (admin only)
// export const generateGroupInviteCode = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id: groupId } = req.params;
//     const { max_uses } = req.body;

//     const adminCheck = await pool.query(
//       `SELECT name FROM inventory_groups
//        WHERE id = $1 AND created_by_user_id = $2`,
//       [groupId, userId]
//     );
//     if (adminCheck.rows.length === 0)
//       return res.status(403).json({ error: "Only the group admin can create invite codes" });

//     const groupName = adminCheck.rows[0].name;
//     let code, attempts = 0;
//     do {
//       code = generateInviteCode(groupName);
//       const exists = await pool.query(
//         `SELECT 1 FROM inventory_group_invite_codes WHERE code = $1`, [code]
//       );
//       if (exists.rows.length === 0) break;
//       attempts++;
//     } while (attempts < 5);

//     const inserted = await pool.query(
//       `INSERT INTO inventory_group_invite_codes
//         (group_id, code, created_by_user_id, max_uses)
//        VALUES ($1, $2, $3, $4)
//        RETURNING *`,
//       [groupId, code, userId, max_uses || 25]
//     );

//     return res.status(201).json(inserted.rows[0]);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("generateGroupInviteCode error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /groups/join-by-code — join group via invite code
// export const joinGroupByCode = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     if (!pharmacyId)
//       return res.status(400).json({ error: "No pharmacy registered for this user" });

//     const { code } = req.body;
//     if (!code || !code.trim())
//       return res.status(400).json({ error: "Invite code is required" });

//     const codeRes = await pool.query(
//       `SELECT c.*, g.name AS group_name, g.max_members,
//          (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = c.group_id) AS member_count
//        FROM inventory_group_invite_codes c
//        JOIN inventory_groups g ON g.id = c.group_id
//        WHERE c.code = $1 AND c.is_active = true
//          AND c.expires_at > NOW()
//          AND g.is_active = true
//        LIMIT 1`,
//       [code.trim().toUpperCase()]
//     );
//     if (codeRes.rows.length === 0)
//       return res.status(404).json({ error: "Invalid or expired invite code" });
//     const inv = codeRes.rows[0];

//     if (inv.uses_count >= inv.max_uses)
//       return res.status(400).json({ error: "This invite code has reached its usage limit" });

//     if (Number(inv.member_count) >= inv.max_members)
//       return res.status(400).json({ error: "Group is at maximum capacity" });

//     const dup = await pool.query(
//       `SELECT 1 FROM inventory_group_members
//        WHERE group_id = $1 AND pharmacy_id = $2`,
//       [inv.group_id, pharmacyId]
//     );
//     if (dup.rows.length > 0)
//       return res.status(400).json({ error: "Your pharmacy is already a member of this group" });

//     // Cap at 5 groups per pharmacy
//     // Cap at 5 ACTIVE groups per pharmacy
// const myCount = await pool.query(
//   `SELECT COUNT(*) FROM inventory_group_members m
//    JOIN inventory_groups g ON g.id = m.group_id
//    WHERE m.pharmacy_id = $1 AND g.is_active = true`,
//   [pharmacyId]
// );
// if (Number(myCount.rows[0].count) >= 5)
//   return res.status(400).json({ error: "You can be in at most 5 groups" });

//     // Add member + bump usage
//     await pool.query(
//       `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
//        VALUES ($1, $2, $3, 'member')`,
//       [inv.group_id, pharmacyId, userId]
//     );
//     await pool.query(
//       `UPDATE inventory_group_invite_codes
//        SET uses_count = uses_count + 1
//        WHERE id = $1`,
//       [inv.id]
//     );

//     return res.json({ ok: true, group_id: inv.group_id, group_name: inv.group_name });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("joinGroupByCode error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /groups/:id/leave — leave a group
// export const leaveGroup = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     const { id: groupId } = req.params;

//     const adminCheck = await pool.query(
//       `SELECT created_by_user_id FROM inventory_groups WHERE id = $1`,
//       [groupId]
//     );
//     if (adminCheck.rows.length === 0)
//       return res.status(404).json({ error: "Group not found" });
//     if (adminCheck.rows[0].created_by_user_id === userId)
//       return res.status(400).json({
//         error: "Group admin cannot leave. Delete the group or transfer ownership first.",
//       });

//     await pool.query(
//       `DELETE FROM inventory_group_members
//        WHERE group_id = $1 AND pharmacy_id = $2`,
//       [groupId, pharmacyId]
//     );

//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("leaveGroup error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // DELETE /groups/:id/members/:memberPharmacyId — admin kicks member
// export const removeGroupMember = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id: groupId, memberPharmacyId } = req.params;

//     const adminCheck = await pool.query(
//       `SELECT created_by_pharmacy_id FROM inventory_groups
//        WHERE id = $1 AND created_by_user_id = $2`,
//       [groupId, userId]
//     );
//     if (adminCheck.rows.length === 0)
//       return res.status(403).json({ error: "Only the group admin can remove members" });

//     if (adminCheck.rows[0].created_by_pharmacy_id === memberPharmacyId)
//       return res.status(400).json({ error: "Cannot remove yourself. Delete the group instead." });

//     await pool.query(
//       `DELETE FROM inventory_group_members
//        WHERE group_id = $1 AND pharmacy_id = $2`,
//       [groupId, memberPharmacyId]
//     );

//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("removeGroupMember error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // DELETE /groups/:id — admin deletes/dissolves group
// // DELETE /groups/:id — admin deletes/dissolves group
// export const deleteGroup = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const { id: groupId } = req.params;

//     const adminCheck = await pool.query(
//       `SELECT 1 FROM inventory_groups
//        WHERE id = $1 AND created_by_user_id = $2`,
//       [groupId, userId]
//     );
//     if (adminCheck.rows.length === 0)
//       return res.status(403).json({ error: "Only the group admin can delete this group" });

//     // Delete all members so they can join/create other groups
//     await pool.query(
//       `DELETE FROM inventory_group_members WHERE group_id = $1`,
//       [groupId]
//     );

//     // Cancel any pending invitations
//     await pool.query(
//       `UPDATE inventory_group_invitations
//        SET status = 'cancelled', responded_at = NOW()
//        WHERE group_id = $1 AND status = 'pending'`,
//       [groupId]
//     );

//     // Deactivate any invite codes
//     await pool.query(
//       `UPDATE inventory_group_invite_codes
//        SET is_active = false
//        WHERE group_id = $1`,
//       [groupId]
//     );

//     // Remove group → listings associations (so listings stop being "groups_only" for this group)
//     await pool.query(
//       `DELETE FROM inventory_listing_groups WHERE group_id = $1`,
//       [groupId]
//     );

//     // Mark group inactive
//     await pool.query(
//       `UPDATE inventory_groups SET is_active = false, updated_at = NOW() WHERE id = $1`,
//       [groupId]
//     );

//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("deleteGroup error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // INVITATIONS — pending invitations inbox
// // ============================================================================

// // GET /invitations — list pending invitations for me
// export const getMyInvitations = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);

//     const userInfo = await pool.query(
//       `SELECT email FROM users WHERE id = $1`, [userId]
//     );
//     const myEmail = userInfo.rows[0]?.email || null;

//     const result = await pool.query(
//       `SELECT
//          i.id, i.message, i.created_at, i.expires_at, i.invited_email,
//          g.id AS group_id, g.name AS group_name, g.description AS group_description,
//          u.name AS inviter_name,
//          p.pharmacy_name AS inviter_pharmacy
//        FROM inventory_group_invitations i
//        JOIN inventory_groups g ON g.id = i.group_id AND g.is_active = true
//        LEFT JOIN users u ON u.id = i.invited_by_user_id
//        LEFT JOIN pharmacy_details p ON p.user_id = u.id
//        WHERE i.status = 'pending'
//          AND i.expires_at > NOW()
//          AND (
//            i.invited_user_id = $1
//            OR i.invited_pharmacy_id = $2
//            OR ($3::text IS NOT NULL AND LOWER(i.invited_email) = LOWER($3))
//          )
//        ORDER BY i.created_at DESC`,
//       [userId, pharmacyId, myEmail]
//     );

//     return res.json(result.rows);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("getMyInvitations error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /invitations/:id/accept
// export const acceptInvitation = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     if (!pharmacyId)
//       return res.status(400).json({ error: "No pharmacy registered for this user" });
//     const { id: invitationId } = req.params;

//     const userInfo = await pool.query(
//       `SELECT email FROM users WHERE id = $1`, [userId]
//     );
//     const myEmail = userInfo.rows[0]?.email || null;

//     const invRes = await pool.query(
//       `SELECT i.*, g.max_members,
//          (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = i.group_id) AS member_count
//        FROM inventory_group_invitations i
//        JOIN inventory_groups g ON g.id = i.group_id
//        WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
//          AND (
//            i.invited_user_id = $2
//            OR i.invited_pharmacy_id = $3
//            OR ($4::text IS NOT NULL AND LOWER(i.invited_email) = LOWER($4))
//          )
//        LIMIT 1`,
//       [invitationId, userId, pharmacyId, myEmail]
//     );
//     if (invRes.rows.length === 0)
//       return res.status(404).json({ error: "Invitation not found or expired" });

//     const inv = invRes.rows[0];
//     if (Number(inv.member_count) >= inv.max_members)
//       return res.status(400).json({ error: "Group is at maximum capacity" });

//     const dup = await pool.query(
//       `SELECT 1 FROM inventory_group_members
//        WHERE group_id = $1 AND pharmacy_id = $2`,
//       [inv.group_id, pharmacyId]
//     );
//     if (dup.rows.length === 0) {
//       await pool.query(
//         `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
//          VALUES ($1, $2, $3, 'member')`,
//         [inv.group_id, pharmacyId, userId]
//       );
//     }

//     await pool.query(
//       `UPDATE inventory_group_invitations
//        SET status = 'accepted', responded_at = NOW()
//        WHERE id = $1`,
//       [invitationId]
//     );

//     return res.json({ ok: true, group_id: inv.group_id });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("acceptInvitation error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // POST /invitations/:id/decline
// export const declineInvitation = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const pharmacyId = await getUserPharmacyId(userId);
//     const { id: invitationId } = req.params;

//     const userInfo = await pool.query(
//       `SELECT email FROM users WHERE id = $1`, [userId]
//     );
//     const myEmail = userInfo.rows[0]?.email || null;

//     const result = await pool.query(
//       `UPDATE inventory_group_invitations
//        SET status = 'declined', responded_at = NOW()
//        WHERE id = $1 AND status = 'pending'
//          AND (
//            invited_user_id = $2
//            OR invited_pharmacy_id = $3
//            OR ($4::text IS NOT NULL AND LOWER(invited_email) = LOWER($4))
//          )
//        RETURNING id`,
//       [invitationId, userId, pharmacyId, myEmail]
//     );
//     if (result.rows.length === 0)
//       return res.status(404).json({ error: "Invitation not found" });

//     return res.json({ ok: true });
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("declineInvitation error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

// // ============================================================================
// // PHARMACY SEARCH — used to invite by name/NPI
// // ============================================================================

// // GET /pharmacies/search?q=...
// export const searchPharmacies = async (req, res) => {
//   try {
//     const userId = requireUser(req);
//     const myPharmacyId = await getUserPharmacyId(userId);
//     const { q } = req.query;
//     if (!q || String(q).trim().length < 2)
//       return res.json([]);
//     const query = String(q).trim();

//     const result = await pool.query(
//       `SELECT
//          p.id, p.pharmacy_name, p.address, p.npi_number, p.ncpdp_number,
//          p.pharmacist_name, u.email
//        FROM pharmacy_details p
//        LEFT JOIN users u ON u.id = p.user_id
//        WHERE p.id != COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')
//          AND (
//            p.pharmacy_name ILIKE $2
//            OR p.npi_number = $3
//            OR p.ncpdp_number = $3
//          )
//        LIMIT 10`,
//       [myPharmacyId, `%${query}%`, query]
//     );

//     return res.json(result.rows);
//   } catch (err) {
//     if (err.status) return res.status(err.status).json({ error: err.message });
//     console.error("searchPharmacies error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// };

import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import {
  sendConnectRequestEmail,
  sendGroupInvitationEmail,
} from "../services/inventoryViewEmail.service.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const requireUser = (req) => {
  const auth = req.headers.authorization;
  if (!auth)
    throw Object.assign(new Error("Authorization header missing"), {
      status: 401,
    });
  const token = auth.split(" ")[1];
  if (!token) throw Object.assign(new Error("Token missing"), { status: 401 });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.userId;
  } catch (e) {
    throw Object.assign(new Error("jwt expired"), { status: 401 });
  }
};

const getUserPharmacyId = async (userId) => {
  const r = await pool.query(
    `SELECT id FROM pharmacy_details WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.id || null;
};

const generateInviteCode = (groupName) => {
  const prefix =
    (groupName || "GROUP")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 8) || "GROUP";
  const segment = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 4; i++)
      s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  };
  return `${prefix}-${segment()}-${segment()}`;
};

const mapListingRow = (r) => ({
  id: r.id,
  ndc: r.ndc,
  drug_name: r.drug_name,
  strength: r.strength,
  dosage_form: r.dosage_form,
  manufacturer: r.manufacturer,
  package_size: r.package_size,
  quantity: r.quantity,
  lot_number: r.lot_number,
  expiry: r.expiry,
  acquisition_cost: r.acquisition_cost ? parseFloat(r.acquisition_cost) : null,
  reason_code: r.reason_code,
  visibility: r.visibility || "public",
  group_ids: r.group_ids || [],
  pharmacy: {
    id: r.pharmacy_id,
    pharmacy_name: r.pharmacy_name,
    address: r.address,
    phone: r.phone,
    fax: r.fax,
    email: r.pharmacy_email,
    npi_number: r.npi_number,
    ncpdp_number: r.ncpdp_number,
    license_expiry_date: r.license_expiry_date,
    pharmacist_name: r.pharmacist_name,
    member_since: r.pharmacy_member_since,
    rating: 5.0,
    total_transfers: 0,
    last_active: null,
  },
  distance_miles: null,
  listed_at: r.listed_at,
  owner_user_id: r.owner_user_id,
});

// ============================================================================
// LISTINGS
// ============================================================================

export const getListings = async (req, res) => {
  try {
    const userId = requireUser(req);
    const myPharmacyId = await getUserPharmacyId(userId);
    const { group_id } = req.query; // NEW: optional filter

    let memberGroupIds = [];
    if (myPharmacyId) {
      const groupsRes = await pool.query(
        `SELECT m.group_id 
         FROM inventory_group_members m
         JOIN inventory_groups g ON g.id = m.group_id
         WHERE m.pharmacy_id = $1 AND g.is_active = true`,
        [myPharmacyId],
      );
      memberGroupIds = groupsRes.rows.map((g) => g.group_id);
    }

    // If group_id is provided, validate the user is a member of that group
    if (group_id) {
      if (!memberGroupIds.includes(group_id)) {
        return res.status(403).json({ error: "Not a member of that group" });
      }
    }

    let whereClause;
    let queryParams;

    if (group_id) {
      // Filter to listings shared with this specific group
      whereClause = `
        AND (
          l.user_id = $1
          OR EXISTS (
            SELECT 1 FROM inventory_listing_groups lg
            WHERE lg.listing_id = l.id AND lg.group_id = $2::uuid
          )
        )
      `;
      queryParams = [userId, group_id];
    } else {
      // Default: own listings + public + groups_only (where I'm a member)
      whereClause = `
        AND (
          l.user_id = $1
          OR l.visibility = 'public'
          OR (
            l.visibility = 'groups_only'
            AND EXISTS (
              SELECT 1 FROM inventory_listing_groups lg
              WHERE lg.listing_id = l.id
                AND lg.group_id = ANY($2::uuid[])
            )
          )
        )
      `;
      queryParams = [userId, memberGroupIds.length ? memberGroupIds : [null]];
    }

    const result = await pool.query(
      `
      SELECT
        l.id, l.ndc, l.drug_name, l.strength, l.dosage_form, l.manufacturer,
        l.package_size, l.quantity, l.lot_number, l.expiry, l.acquisition_cost,
        l.reason_code, l.visibility,
        l.created_at AS listed_at,
        l.user_id AS owner_user_id,
        p.id AS pharmacy_id, p.pharmacy_name, p.address, p.phone, p.fax,
        p.npi_number, p.ncpdp_number, p.license_expiry_date,
        p.pharmacist_name, p.created_at AS pharmacy_member_since,
        u.email AS pharmacy_email,
        COALESCE(
          ARRAY(SELECT group_id FROM inventory_listing_groups WHERE listing_id = l.id),
          ARRAY[]::uuid[]
        ) AS group_ids
      FROM inventory_listings l
      LEFT JOIN pharmacy_details p ON p.id = l.pharmacy_id
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.is_active = true
        AND (l.auto_expires_at IS NULL OR l.auto_expires_at > NOW())
        ${whereClause}
      ORDER BY l.created_at DESC
      `,
      queryParams,
    );

    const all = result.rows.map(mapListingRow);
    const listings = all.filter((l) => l.owner_user_id !== userId);
    const my_listings = all.filter((l) => l.owner_user_id === userId);

    return res.json({ listings, my_listings });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("getListings error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const createListing = async (req, res) => {
  try {
    const userId = requireUser(req);
    const {
      ndc,
      drug_name,
      strength,
      dosage_form,
      manufacturer,
      package_size,
      lot_number,
      expiry,
      quantity,
      acquisition_cost,
      reason_code,
      visibility = "public",
      group_ids = [],
    } = req.body;

    if (
      !ndc ||
      !drug_name ||
      !lot_number ||
      !expiry ||
      !quantity ||
      !reason_code
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId) {
      return res
        .status(400)
        .json({ error: "No pharmacy registered for this user" });
    }

    const finalVisibility =
      visibility === "groups_only" &&
      Array.isArray(group_ids) &&
      group_ids.length > 0
        ? "groups_only"
        : "public";

    const result = await pool.query(
      `INSERT INTO inventory_listings
        (user_id, pharmacy_id, ndc, drug_name, strength, dosage_form,
         manufacturer, package_size, quantity, lot_number, expiry,
         acquisition_cost, reason_code, visibility, is_active, auto_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW() + INTERVAL '30 days')
       RETURNING *`,
      [
        userId,
        pharmacyId,
        ndc,
        drug_name,
        strength || null,
        dosage_form || null,
        manufacturer || null,
        package_size || null,
        parseInt(quantity, 10),
        lot_number,
        expiry,
        acquisition_cost ? parseFloat(acquisition_cost) : null,
        reason_code,
        finalVisibility,
      ],
    );
    const listing = result.rows[0];

    if (finalVisibility === "groups_only" && group_ids.length > 0) {
      const validGroups = await pool.query(
        `SELECT m.group_id FROM inventory_group_members m
         JOIN inventory_groups g ON g.id = m.group_id
         WHERE m.pharmacy_id = $1 AND m.group_id = ANY($2::uuid[]) AND g.is_active = true`,
        [pharmacyId, group_ids],
      );

      for (const g of validGroups.rows) {
        await pool.query(
          `INSERT INTO inventory_listing_groups (listing_id, group_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [listing.id, g.group_id],
        );
      }
    }

    return res.status(201).json(listing);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("createListing error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const updateListing = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;
    const {
      quantity,
      expiry,
      acquisition_cost,
      reason_code,
      visibility,
      group_ids,
    } = req.body;

    const ownerCheck = await pool.query(
      `SELECT user_id FROM inventory_listings WHERE id = $1`,
      [id],
    );
    if (ownerCheck.rows.length === 0)
      return res.status(404).json({ error: "Listing not found" });
    if (ownerCheck.rows[0].user_id !== userId)
      return res
        .status(403)
        .json({ error: "Not authorized to update this listing" });

    const sets = [];
    const params = [];
    let p = 1;

    if (quantity !== undefined) {
      const q = parseInt(quantity, 10);
      if (isNaN(q) || q < 1)
        return res
          .status(400)
          .json({ error: "Quantity must be a positive integer" });
      sets.push(`quantity = $${p++}`);
      params.push(q);
    }
    if (expiry !== undefined) {
      sets.push(`expiry = $${p++}`);
      params.push(expiry || null);
    }
    if (acquisition_cost !== undefined) {
      sets.push(`acquisition_cost = $${p++}`);
      params.push(acquisition_cost ? parseFloat(acquisition_cost) : null);
    }
    if (reason_code !== undefined) {
      sets.push(`reason_code = $${p++}`);
      params.push(reason_code);
    }
    if (visibility !== undefined) {
      const v = visibility === "groups_only" ? "groups_only" : "public";
      sets.push(`visibility = $${p++}`);
      params.push(v);
    }

    if (sets.length === 0 && group_ids === undefined)
      return res.status(400).json({ error: "No fields to update" });

    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      params.push(id);
      await pool.query(
        `UPDATE inventory_listings SET ${sets.join(", ")} WHERE id = $${p}`,
        params,
      );
    }

    if (Array.isArray(group_ids)) {
      const pharmacyId = await getUserPharmacyId(userId);
      await pool.query(
        `DELETE FROM inventory_listing_groups WHERE listing_id = $1`,
        [id],
      );
      if (group_ids.length > 0) {
        const validGroups = await pool.query(
          `SELECT m.group_id FROM inventory_group_members m
           JOIN inventory_groups g ON g.id = m.group_id
           WHERE m.pharmacy_id = $1 AND m.group_id = ANY($2::uuid[]) AND g.is_active = true`,
          [pharmacyId, group_ids],
        );
        for (const g of validGroups.rows) {
          await pool.query(
            `INSERT INTO inventory_listing_groups (listing_id, group_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, g.group_id],
          );
        }
      }
    }

    const updated = await pool.query(
      `SELECT * FROM inventory_listings WHERE id = $1`,
      [id],
    );
    return res.json(updated.rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("updateListing error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const deleteListing = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id } = req.params;

    const ownerCheck = await pool.query(
      `SELECT user_id FROM inventory_listings WHERE id = $1`,
      [id],
    );
    if (ownerCheck.rows.length === 0)
      return res.status(404).json({ error: "Listing not found" });
    if (ownerCheck.rows[0].user_id !== userId)
      return res
        .status(403)
        .json({ error: "Not authorized to delete this listing" });

    await pool.query(
      `UPDATE inventory_listings SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id],
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("deleteListing error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// REPORT
// ============================================================================

export const reportListing = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: listingId } = req.params;
    const { reason_code, details } = req.body;

    if (!reason_code)
      return res.status(400).json({ error: "Reason is required" });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_listing_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID,
        reporter_user_id UUID NOT NULL,
        reason_code TEXT NOT NULL,
        details TEXT,
        status TEXT DEFAULT 'open',
        reviewed_by UUID,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const listingCheck = await pool.query(
      `SELECT id FROM inventory_listings WHERE id = $1`,
      [listingId],
    );
    if (listingCheck.rows.length === 0)
      return res.status(404).json({ error: "Listing not found" });

    const result = await pool.query(
      `INSERT INTO inventory_listing_reports
        (listing_id, reporter_user_id, reason_code, details)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [listingId, userId, reason_code, details || null],
    );

    return res.status(201).json({ ok: true, report_id: result.rows[0].id });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("reportListing error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// AGREEMENT
// ============================================================================

export const getAgreementStatus = async (req, res) => {
  try {
    const userId = requireUser(req);
    const result = await pool.query(
      `SELECT id, accepted_at, agreement_version
       FROM inventory_agreement_acceptances
       WHERE user_id = $1
       ORDER BY accepted_at DESC LIMIT 1`,
      [userId],
    );
    return res.json({
      accepted: result.rows.length > 0,
      accepted_at: result.rows[0]?.accepted_at || null,
      version: result.rows[0]?.agreement_version || null,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("getAgreementStatus error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const acceptAgreement = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { version } = req.body;
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket?.remoteAddress ||
      null;
    const ua = req.headers["user-agent"] || null;
    const pharmacyId = await getUserPharmacyId(userId);

    await pool.query(
      `INSERT INTO inventory_agreement_acceptances
        (user_id, pharmacy_id, agreement_version, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, agreement_version) DO NOTHING`,
      [userId, pharmacyId, version || "1.0", ip, ua],
    );
    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("acceptAgreement error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// CONNECT REQUEST
// ============================================================================

export const sendConnectRequest = async (req, res) => {
  try {
    const userId = requireUser(req);
    const {
      listing_id,
      seller_pharmacy_id,
      seller_email,
      // patient_rx,
      quantity,
      notes,
      email_subject,
      email_body,
    } = req.body;

    if (!listing_id || !seller_email || !email_subject || !email_body)
      return res.status(400).json({ error: "Missing required fields" });

    const buyerPharmacyId = await getUserPharmacyId(userId);

    const sellerUserRes = await pool.query(
      `SELECT user_id FROM inventory_listings WHERE id = $1`,
      [listing_id],
    );
    const sellerUserId = sellerUserRes.rows[0]?.user_id || null;

    const buyerInfoRes = await pool.query(
      `SELECT name, email FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const buyerName = buyerInfoRes.rows[0]?.name || null;
    const buyerEmail = buyerInfoRes.rows[0]?.email || null;

    const insertRes = await pool.query(
      `INSERT INTO inventory_connect_requests
        (listing_id, buyer_user_id, buyer_pharmacy_id,
         seller_user_id, seller_pharmacy_id, seller_email,
        quantity, notes,
         email_subject, email_body, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING id`,
      [
        listing_id,
        userId,
        buyerPharmacyId,
        sellerUserId,
        seller_pharmacy_id,
        seller_email,
        // patient_rx,
        parseInt(quantity, 10),
        notes,
        email_subject,
        email_body,
      ],
    );
    const requestId = insertRes.rows[0].id;

    let messageId = null;
    let status = "sent";
    let emailError = null;
    try {
      const result = await sendConnectRequestEmail({
        to: seller_email,
        subject: email_subject,
        body: email_body,
        buyerName,
        buyerEmail,
      });
      messageId = result?.messageId || null;
    } catch (mailErr) {
      console.error("Email send failed:", mailErr);
      status = "failed";
      emailError = mailErr.message;
    }

    await pool.query(
      `UPDATE inventory_connect_requests
       SET status = $1, email_sent_at = NOW(), email_message_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [status, messageId, requestId],
    );

    return res.json({
      ok: status === "sent",
      request_id: requestId,
      status,
      email_error: emailError,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("sendConnectRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// GROUPS
// ============================================================================

export const getMyGroups = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId) return res.json([]);

    const result = await pool.query(
      `SELECT
         g.id, g.name, g.description, g.max_members, g.created_at,
         g.created_by_user_id, g.is_discoverable,
         m.role,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = g.id) AS member_count,
         (g.created_by_user_id = $1) AS is_admin,
         (SELECT COUNT(*) FROM inventory_group_invitations 
          WHERE group_id = g.id 
            AND status = 'pending' 
            AND direction = 'user_to_admin') AS pending_join_requests
       FROM inventory_groups g
       JOIN inventory_group_members m ON m.group_id = g.id
       WHERE m.pharmacy_id = $2
         AND g.is_active = true
       ORDER BY g.created_at DESC`,
      [userId, pharmacyId],
    );

    return res.json(
      result.rows.map((r) => ({
        ...r,
        member_count: Number(r.member_count),
        pending_join_requests: Number(r.pending_join_requests),
      })),
    );
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("getMyGroups error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// NEW: GET /groups/discover — list all discoverable groups user is NOT in
export const discoverGroups = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId) return res.json([]);

    const result = await pool.query(
      `SELECT
         g.id, g.name, g.description, g.max_members, g.created_at,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = g.id) AS member_count,
         creator_pd.pharmacy_name AS admin_pharmacy_name,
         (SELECT 1 FROM inventory_group_invitations
          WHERE group_id = g.id
            AND status = 'pending'
            AND direction = 'user_to_admin'
            AND (invited_pharmacy_id = $1 OR invited_user_id = $2)
          LIMIT 1) AS has_pending_request
       FROM inventory_groups g
       LEFT JOIN pharmacy_details creator_pd ON creator_pd.id = g.created_by_pharmacy_id
       WHERE g.is_active = true
         AND g.is_discoverable = true
         AND NOT EXISTS (
           SELECT 1 FROM inventory_group_members m
           WHERE m.group_id = g.id AND m.pharmacy_id = $1
         )
       ORDER BY g.created_at DESC`,
      [pharmacyId, userId],
    );

    return res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        max_members: r.max_members,
        member_count: Number(r.member_count),
        admin_pharmacy_name: r.admin_pharmacy_name,
        created_at: r.created_at,
        has_pending_request: !!r.has_pending_request,
      })),
    );
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("discoverGroups error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// NEW: POST /groups/:id/request-join — user requests to join a group
export const requestJoinGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId)
      return res
        .status(400)
        .json({ error: "No pharmacy registered for this user" });

    const { id: groupId } = req.params;
    const { message } = req.body;

    // Group must exist, be active, and discoverable
    const groupRes = await pool.query(
      `SELECT id, name, max_members, is_discoverable,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = inventory_groups.id) AS member_count
       FROM inventory_groups
       WHERE id = $1 AND is_active = true`,
      [groupId],
    );
    if (groupRes.rows.length === 0)
      return res.status(404).json({ error: "Group not found" });
    const group = groupRes.rows[0];

    if (!group.is_discoverable)
      return res
        .status(403)
        .json({ error: "This group is private and cannot be joined directly" });

    if (Number(group.member_count) >= group.max_members)
      return res.status(400).json({ error: "Group is at maximum capacity" });

    // Already a member?
    const dup = await pool.query(
      `SELECT 1 FROM inventory_group_members
       WHERE group_id = $1 AND pharmacy_id = $2`,
      [groupId, pharmacyId],
    );
    if (dup.rows.length > 0)
      return res
        .status(400)
        .json({ error: "You are already a member of this group" });

    // Cap at 5 active groups per pharmacy
    const myCount = await pool.query(
      `SELECT COUNT(*) FROM inventory_group_members m
       JOIN inventory_groups g ON g.id = m.group_id
       WHERE m.pharmacy_id = $1 AND g.is_active = true`,
      [pharmacyId],
    );
    if (Number(myCount.rows[0].count) >= 5)
      return res.status(400).json({ error: "You can be in at most 5 groups" });

    // Already a pending join request OR invitation?
    const dupInv = await pool.query(
      `SELECT 1 FROM inventory_group_invitations
       WHERE group_id = $1 AND status = 'pending'
         AND (invited_pharmacy_id = $2 OR invited_user_id = $3)`,
      [groupId, pharmacyId, userId],
    );
    if (dupInv.rows.length > 0)
      return res.status(400).json({
        error:
          "You already have a pending request or invitation for this group",
      });

    // Insert join request
    const inv = await pool.query(
      `INSERT INTO inventory_group_invitations
        (group_id, invited_user_id, invited_pharmacy_id,
         invited_by_user_id, message, direction, status)
       VALUES ($1, $2, $3, $4, $5, 'user_to_admin', 'pending')
       RETURNING *`,
      [groupId, userId, pharmacyId, userId, message || null],
    );

    return res.status(201).json({ ok: true, request: inv.rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("requestJoinGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const createGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId)
      return res
        .status(400)
        .json({ error: "No pharmacy registered for this user" });

    const { name, description, is_discoverable = true } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "Group name is required" });

    // Cap at 5 ACTIVE groups per pharmacy
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM inventory_group_members m
       JOIN inventory_groups g ON g.id = m.group_id
       WHERE m.pharmacy_id = $1 AND g.is_active = true`,
      [pharmacyId],
    );
    if (Number(countRes.rows[0].count) >= 5)
      return res.status(400).json({ error: "You can be in at most 5 groups." });

    const groupRes = await pool.query(
      `INSERT INTO inventory_groups
        (name, description, created_by_user_id, created_by_pharmacy_id, is_discoverable)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), description || null, userId, pharmacyId, !!is_discoverable],
    );
    const group = groupRes.rows[0];

    await pool.query(
      `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
       VALUES ($1, $2, $3, 'admin')`,
      [group.id, pharmacyId, userId],
    );

    return res.status(201).json(group);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("createGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// NEW: PATCH /groups/:id — admin toggles is_discoverable / updates group meta
export const updateGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: groupId } = req.params;
    const { is_discoverable, name, description } = req.body;

    const adminCheck = await pool.query(
      `SELECT 1 FROM inventory_groups
       WHERE id = $1 AND created_by_user_id = $2 AND is_active = true`,
      [groupId, userId],
    );
    if (adminCheck.rows.length === 0)
      return res
        .status(403)
        .json({ error: "Only the group admin can update this group" });

    const sets = [];
    const params = [];
    let p = 1;

    if (is_discoverable !== undefined) {
      sets.push(`is_discoverable = $${p++}`);
      params.push(!!is_discoverable);
    }
    if (name !== undefined) {
      if (!name.trim())
        return res.status(400).json({ error: "Name cannot be empty" });
      sets.push(`name = $${p++}`);
      params.push(name.trim());
    }
    if (description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(description || null);
    }

    if (sets.length === 0)
      return res.status(400).json({ error: "No fields to update" });

    sets.push(`updated_at = NOW()`);
    params.push(groupId);

    const result = await pool.query(
      `UPDATE inventory_groups SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      params,
    );

    return res.json(result.rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("updateGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const getGroupDetail = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    const { id } = req.params;

    const memCheck = await pool.query(
      `SELECT 1 FROM inventory_group_members WHERE group_id = $1 AND pharmacy_id = $2`,
      [id, pharmacyId],
    );
    if (memCheck.rows.length === 0)
      return res.status(403).json({ error: "Not a member of this group" });

    const groupRes = await pool.query(
      `SELECT g.*, (g.created_by_user_id = $1) AS is_admin
       FROM inventory_groups g WHERE g.id = $2 AND g.is_active = true`,
      [userId, id],
    );
    if (groupRes.rows.length === 0)
      return res.status(404).json({ error: "Group not found" });
    const group = groupRes.rows[0];

    const membersRes = await pool.query(
      `SELECT
         m.id, m.role, m.joined_at,
         m.pharmacy_id, m.user_id,
         p.pharmacy_name, p.address, p.npi_number, p.ncpdp_number, p.phone,
         u.name AS user_name, u.email AS user_email
       FROM inventory_group_members m
       LEFT JOIN pharmacy_details p ON p.id = m.pharmacy_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY m.role DESC, m.joined_at ASC`,
      [id],
    );

    const codesRes = await pool.query(
      `SELECT id, code, max_uses, uses_count, expires_at, created_at, is_active
       FROM inventory_group_invite_codes
       WHERE group_id = $1 AND is_active = true AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [id],
    );

    // Pending invitations FROM admin (sent by admin to others)
    const invitesRes = await pool.query(
      `SELECT
         i.id, i.invited_email, i.status, i.created_at, i.expires_at, i.message,
         p.pharmacy_name AS invited_pharmacy_name,
         u.email AS invited_user_email
       FROM inventory_group_invitations i
       LEFT JOIN pharmacy_details p ON p.id = i.invited_pharmacy_id
       LEFT JOIN users u ON u.id = i.invited_user_id
       WHERE i.group_id = $1 
         AND i.status = 'pending'
         AND i.direction = 'admin_to_user'
       ORDER BY i.created_at DESC`,
      [id],
    );

    // Pending join requests TO admin (someone wants to join)
    const joinRequestsRes = await pool.query(
      `SELECT
         i.id, i.message, i.created_at, i.expires_at,
         p.pharmacy_name AS requester_pharmacy_name,
         p.address AS requester_address,
         p.npi_number AS requester_npi,
         u.name AS requester_name,
         u.email AS requester_email
       FROM inventory_group_invitations i
       LEFT JOIN pharmacy_details p ON p.id = i.invited_pharmacy_id
       LEFT JOIN users u ON u.id = i.invited_user_id
       WHERE i.group_id = $1
         AND i.status = 'pending'
         AND i.direction = 'user_to_admin'
       ORDER BY i.created_at DESC`,
      [id],
    );

    return res.json({
      group,
      members: membersRes.rows,
      invite_codes: codesRes.rows,
      pending_invitations: invitesRes.rows,
      pending_join_requests: joinRequestsRes.rows,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("getGroupDetail error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const inviteToGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: groupId } = req.params;
    const { pharmacy_id, email, message } = req.body;

    const adminCheck = await pool.query(
      `SELECT 1 FROM inventory_groups WHERE id = $1 AND created_by_user_id = $2`,
      [groupId, userId],
    );
    if (adminCheck.rows.length === 0)
      return res
        .status(403)
        .json({ error: "Only the group admin can invite members" });

    const groupRes = await pool.query(
      `SELECT name, max_members,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = $1) AS member_count
       FROM inventory_groups WHERE id = $1`,
      [groupId],
    );
    if (groupRes.rows.length === 0)
      return res.status(404).json({ error: "Group not found" });
    const group = groupRes.rows[0];
    if (Number(group.member_count) >= group.max_members)
      return res.status(400).json({ error: "Group is at maximum capacity" });

    let invitedPharmacyId = pharmacy_id || null;
    let invitedUserId = null;
    let invitedEmail = email || null;

    if (invitedPharmacyId) {
      const userRes = await pool.query(
        `SELECT user_id FROM pharmacy_details WHERE id = $1`,
        [invitedPharmacyId],
      );
      if (userRes.rows.length === 0)
        return res.status(404).json({ error: "Pharmacy not found" });
      invitedUserId = userRes.rows[0].user_id;
      const userInfo = await pool.query(
        `SELECT email FROM users WHERE id = $1`,
        [invitedUserId],
      );
      invitedEmail = userInfo.rows[0]?.email || invitedEmail;
    } else if (invitedEmail) {
      const userRes = await pool.query(
        `SELECT u.id, p.id AS pharmacy_id
     FROM users u
     LEFT JOIN pharmacy_details p ON p.user_id = u.id
     WHERE LOWER(u.email) = LOWER($1)
     LIMIT 1`,
        [invitedEmail],
      );

      // -----------------------------------------
      // USER NOT ONBOARDED
      // -----------------------------------------

      if (userRes.rows.length === 0) {
        return res.status(404).json({
          error: "This member is not onboarded on our platform yet",
        });
      }

      invitedUserId = userRes.rows[0].id;
      invitedPharmacyId = userRes.rows[0].pharmacy_id;
    } else {
      return res
        .status(400)
        .json({ error: "Provide either pharmacy_id or email" });
    }

    if (invitedPharmacyId) {
      const dup = await pool.query(
        `SELECT 1 FROM inventory_group_members
         WHERE group_id = $1 AND pharmacy_id = $2`,
        [groupId, invitedPharmacyId],
      );
      if (dup.rows.length > 0)
        return res
          .status(400)
          .json({ error: "This pharmacy is already a member" });
    }
    const dupInv = await pool.query(
      `SELECT 1 FROM inventory_group_invitations
       WHERE group_id = $1 AND status = 'pending'
         AND (invited_pharmacy_id = $2 OR (invited_email IS NOT NULL AND LOWER(invited_email) = LOWER($3)))`,
      [groupId, invitedPharmacyId, invitedEmail],
    );
    if (dupInv.rows.length > 0)
      return res.status(400).json({
        error: "An invitation is already pending for this pharmacy/email",
      });

    const inv = await pool.query(
      `INSERT INTO inventory_group_invitations
        (group_id, invited_email, invited_user_id, invited_pharmacy_id,
         invited_by_user_id, message, direction)
       VALUES ($1, $2, $3, $4, $5, $6, 'admin_to_user')
       RETURNING *`,
      [
        groupId,
        invitedEmail || null,
        invitedUserId,
        invitedPharmacyId,
        userId,
        message || null,
      ],
    );

    if (invitedEmail) {
      try {
        const inviterRes = await pool.query(
          `SELECT u.name, p.pharmacy_name
           FROM users u
           LEFT JOIN pharmacy_details p ON p.user_id = u.id
           WHERE u.id = $1`,
          [userId],
        );
        const inviter = inviterRes.rows[0] || {};
        await sendGroupInvitationEmail({
          to: invitedEmail,
          groupName: group.name,
          inviterName: inviter.name || "A pharmacy",
          inviterPharmacy: inviter.pharmacy_name || "",
          message: message || null,
        });
      } catch (mailErr) {
        console.warn(
          "Group invitation email failed (non-fatal):",
          mailErr.message,
        );
      }
    }

    return res.status(201).json({ ok: true, invitation: inv.rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("inviteToGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const generateGroupInviteCode = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: groupId } = req.params;
    const { max_uses } = req.body;

    const adminCheck = await pool.query(
      `SELECT name FROM inventory_groups
       WHERE id = $1 AND created_by_user_id = $2`,
      [groupId, userId],
    );
    if (adminCheck.rows.length === 0)
      return res
        .status(403)
        .json({ error: "Only the group admin can create invite codes" });

    const groupName = adminCheck.rows[0].name;
    let code,
      attempts = 0;
    do {
      code = generateInviteCode(groupName);
      const exists = await pool.query(
        `SELECT 1 FROM inventory_group_invite_codes WHERE code = $1`,
        [code],
      );
      if (exists.rows.length === 0) break;
      attempts++;
    } while (attempts < 5);

    const inserted = await pool.query(
      `INSERT INTO inventory_group_invite_codes
        (group_id, code, created_by_user_id, max_uses)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [groupId, code, userId, max_uses || 25],
    );

    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("generateGroupInviteCode error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const joinGroupByCode = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    if (!pharmacyId)
      return res
        .status(400)
        .json({ error: "No pharmacy registered for this user" });

    const { code } = req.body;
    if (!code || !code.trim())
      return res.status(400).json({ error: "Invite code is required" });

    const codeRes = await pool.query(
      `SELECT c.*, g.name AS group_name, g.max_members,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = c.group_id) AS member_count
       FROM inventory_group_invite_codes c
       JOIN inventory_groups g ON g.id = c.group_id
       WHERE c.code = $1 AND c.is_active = true
         AND c.expires_at > NOW()
         AND g.is_active = true
       LIMIT 1`,
      [code.trim().toUpperCase()],
    );
    if (codeRes.rows.length === 0)
      return res.status(404).json({ error: "Invalid or expired invite code" });
    const inv = codeRes.rows[0];

    if (inv.uses_count >= inv.max_uses)
      return res
        .status(400)
        .json({ error: "This invite code has reached its usage limit" });

    if (Number(inv.member_count) >= inv.max_members)
      return res.status(400).json({ error: "Group is at maximum capacity" });

    const dup = await pool.query(
      `SELECT 1 FROM inventory_group_members
       WHERE group_id = $1 AND pharmacy_id = $2`,
      [inv.group_id, pharmacyId],
    );
    if (dup.rows.length > 0)
      return res
        .status(400)
        .json({ error: "Your pharmacy is already a member of this group" });

    const myCount = await pool.query(
      `SELECT COUNT(*) FROM inventory_group_members m
       JOIN inventory_groups g ON g.id = m.group_id
       WHERE m.pharmacy_id = $1 AND g.is_active = true`,
      [pharmacyId],
    );
    if (Number(myCount.rows[0].count) >= 5)
      return res.status(400).json({ error: "You can be in at most 5 groups" });

    await pool.query(
      `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [inv.group_id, pharmacyId, userId],
    );
    await pool.query(
      `UPDATE inventory_group_invite_codes
       SET uses_count = uses_count + 1
       WHERE id = $1`,
      [inv.id],
    );

    return res.json({
      ok: true,
      group_id: inv.group_id,
      group_name: inv.group_name,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("joinGroupByCode error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    const { id: groupId } = req.params;

    const adminCheck = await pool.query(
      `SELECT created_by_user_id FROM inventory_groups WHERE id = $1`,
      [groupId],
    );
    if (adminCheck.rows.length === 0)
      return res.status(404).json({ error: "Group not found" });
    if (adminCheck.rows[0].created_by_user_id === userId)
      return res.status(400).json({
        error:
          "Group admin cannot leave. Delete the group or transfer ownership first.",
      });

    await pool.query(
      `DELETE FROM inventory_group_members
       WHERE group_id = $1 AND pharmacy_id = $2`,
      [groupId, pharmacyId],
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("leaveGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const removeGroupMember = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: groupId, memberPharmacyId } = req.params;

    const adminCheck = await pool.query(
      `SELECT created_by_pharmacy_id FROM inventory_groups
       WHERE id = $1 AND created_by_user_id = $2`,
      [groupId, userId],
    );
    if (adminCheck.rows.length === 0)
      return res
        .status(403)
        .json({ error: "Only the group admin can remove members" });

    if (adminCheck.rows[0].created_by_pharmacy_id === memberPharmacyId)
      return res
        .status(400)
        .json({ error: "Cannot remove yourself. Delete the group instead." });

    await pool.query(
      `DELETE FROM inventory_group_members
       WHERE group_id = $1 AND pharmacy_id = $2`,
      [groupId, memberPharmacyId],
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("removeGroupMember error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const deleteGroup = async (req, res) => {
  try {
    const userId = requireUser(req);
    const { id: groupId } = req.params;

    const adminCheck = await pool.query(
      `SELECT 1 FROM inventory_groups
       WHERE id = $1 AND created_by_user_id = $2`,
      [groupId, userId],
    );
    if (adminCheck.rows.length === 0)
      return res
        .status(403)
        .json({ error: "Only the group admin can delete this group" });

    // Clean up so members can join/create other groups
    await pool.query(
      `DELETE FROM inventory_group_members WHERE group_id = $1`,
      [groupId],
    );
    await pool.query(
      `UPDATE inventory_group_invitations 
       SET status = 'cancelled', responded_at = NOW()
       WHERE group_id = $1 AND status = 'pending'`,
      [groupId],
    );
    await pool.query(
      `UPDATE inventory_group_invite_codes 
       SET is_active = false 
       WHERE group_id = $1`,
      [groupId],
    );
    await pool.query(
      `DELETE FROM inventory_listing_groups WHERE group_id = $1`,
      [groupId],
    );
    await pool.query(
      `UPDATE inventory_groups SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [groupId],
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("deleteGroup error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// INVITATIONS — pending invitations & join requests inbox
// ============================================================================

// GET /invitations — returns BOTH directions, frontend splits them
export const getMyInvitations = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);

    const userInfo = await pool.query(`SELECT email FROM users WHERE id = $1`, [
      userId,
    ]);
    const myEmail = userInfo.rows[0]?.email || null;

    // Invitations TO ME (admin invited me to join their group)
    const invitesToMe = await pool.query(
      `SELECT
         i.id, i.message, i.created_at, i.expires_at, i.invited_email,
         g.id AS group_id, g.name AS group_name, g.description AS group_description,
         u.name AS inviter_name,
         p.pharmacy_name AS inviter_pharmacy
       FROM inventory_group_invitations i
       JOIN inventory_groups g ON g.id = i.group_id AND g.is_active = true
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       LEFT JOIN pharmacy_details p ON p.user_id = u.id
       WHERE i.status = 'pending'
         AND i.expires_at > NOW()
         AND i.direction = 'admin_to_user'
         AND (
           i.invited_user_id = $1
           OR i.invited_pharmacy_id = $2
           OR ($3::text IS NOT NULL AND LOWER(i.invited_email) = LOWER($3))
         )
       ORDER BY i.created_at DESC`,
      [userId, pharmacyId, myEmail],
    );

    // Join requests FOR MY GROUPS (someone wants to join a group I admin)
    const joinRequestsForMe = await pool.query(
      `SELECT
     i.id, i.message, i.created_at, i.expires_at,
     g.id AS group_id, g.name AS group_name,
     requester_pd.pharmacy_name AS requester_pharmacy,
     requester_pd.phone AS requester_phone,
     requester_pd.address AS requester_address,
     requester_pd.npi_number AS requester_npi,
     requester_u.name AS requester_name
   FROM inventory_group_invitations i
   JOIN inventory_groups g ON g.id = i.group_id AND g.is_active = true
   LEFT JOIN pharmacy_details requester_pd ON requester_pd.id = i.invited_pharmacy_id
   LEFT JOIN users requester_u ON requester_u.id = i.invited_user_id
   WHERE i.status = 'pending'
     AND i.expires_at > NOW()
     AND i.direction = 'user_to_admin'
     AND g.created_by_user_id = $1
   ORDER BY i.created_at DESC`,
      [userId],
    );

    return res.json({
      invitations: invitesToMe.rows,
      join_requests: joinRequestsForMe.rows,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("getMyInvitations error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /invitations/:id/accept — works for BOTH directions
//   admin_to_user: invitee accepts → joins group
//   user_to_admin: admin accepts → adds requester as member
export const acceptInvitation = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    const { id: invitationId } = req.params;

    const userInfo = await pool.query(`SELECT email FROM users WHERE id = $1`, [
      userId,
    ]);
    const myEmail = userInfo.rows[0]?.email || null;

    const invRes = await pool.query(
      `SELECT i.*, g.max_members, g.created_by_user_id,
         (SELECT COUNT(*) FROM inventory_group_members WHERE group_id = i.group_id) AS member_count
       FROM inventory_group_invitations i
       JOIN inventory_groups g ON g.id = i.group_id AND g.is_active = true
       WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
       LIMIT 1`,
      [invitationId],
    );
    if (invRes.rows.length === 0)
      return res.status(404).json({ error: "Invitation not found or expired" });

    const inv = invRes.rows[0];

    let memberPharmacyId, memberUserId;

    if (inv.direction === "admin_to_user") {
      // I'm the invitee — verify it's for me
      const isForMe =
        inv.invited_user_id === userId ||
        inv.invited_pharmacy_id === pharmacyId ||
        (myEmail &&
          inv.invited_email &&
          inv.invited_email.toLowerCase() === myEmail.toLowerCase());
      if (!isForMe) return res.status(403).json({ error: "Not authorized" });
      if (!pharmacyId)
        return res
          .status(400)
          .json({ error: "No pharmacy registered for this user" });
      memberPharmacyId = pharmacyId;
      memberUserId = userId;
    } else {
      // direction = 'user_to_admin' — I'm the admin approving the request
      if (inv.created_by_user_id !== userId)
        return res
          .status(403)
          .json({ error: "Only the group admin can approve join requests" });
      memberPharmacyId = inv.invited_pharmacy_id;
      memberUserId = inv.invited_user_id;
      if (!memberPharmacyId)
        return res.status(400).json({ error: "Requester pharmacy not found" });
    }

    if (Number(inv.member_count) >= inv.max_members)
      return res.status(400).json({ error: "Group is at maximum capacity" });

    // Cap requester at 5 active groups
    const targetCount = await pool.query(
      `SELECT COUNT(*) FROM inventory_group_members m
       JOIN inventory_groups g ON g.id = m.group_id
       WHERE m.pharmacy_id = $1 AND g.is_active = true`,
      [memberPharmacyId],
    );
    if (Number(targetCount.rows[0].count) >= 5)
      return res.status(400).json({
        error:
          inv.direction === "admin_to_user"
            ? "You can be in at most 5 groups"
            : "Requester is already in 5 groups",
      });

    const dup = await pool.query(
      `SELECT 1 FROM inventory_group_members
       WHERE group_id = $1 AND pharmacy_id = $2`,
      [inv.group_id, memberPharmacyId],
    );
    if (dup.rows.length === 0) {
      await pool.query(
        `INSERT INTO inventory_group_members (group_id, pharmacy_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [inv.group_id, memberPharmacyId, memberUserId],
      );
    }

    await pool.query(
      `UPDATE inventory_group_invitations
       SET status = 'accepted', responded_at = NOW()
       WHERE id = $1`,
      [invitationId],
    );

    return res.json({ ok: true, group_id: inv.group_id });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("acceptInvitation error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /invitations/:id/decline — works for BOTH directions
export const declineInvitation = async (req, res) => {
  try {
    const userId = requireUser(req);
    const pharmacyId = await getUserPharmacyId(userId);
    const { id: invitationId } = req.params;

    const userInfo = await pool.query(`SELECT email FROM users WHERE id = $1`, [
      userId,
    ]);
    const myEmail = userInfo.rows[0]?.email || null;

    const invRes = await pool.query(
      `SELECT i.*, g.created_by_user_id
       FROM inventory_group_invitations i
       JOIN inventory_groups g ON g.id = i.group_id
       WHERE i.id = $1 AND i.status = 'pending'
       LIMIT 1`,
      [invitationId],
    );
    if (invRes.rows.length === 0)
      return res.status(404).json({ error: "Invitation not found" });
    const inv = invRes.rows[0];

    let isAuthorized;
    if (inv.direction === "admin_to_user") {
      // Only the invitee can decline
      isAuthorized =
        inv.invited_user_id === userId ||
        inv.invited_pharmacy_id === pharmacyId ||
        (myEmail &&
          inv.invited_email &&
          inv.invited_email.toLowerCase() === myEmail.toLowerCase());
    } else {
      // Only the admin can decline a join request
      isAuthorized = inv.created_by_user_id === userId;
    }

    if (!isAuthorized) return res.status(403).json({ error: "Not authorized" });

    await pool.query(
      `UPDATE inventory_group_invitations
       SET status = 'declined', responded_at = NOW()
       WHERE id = $1`,
      [invitationId],
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("declineInvitation error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// PHARMACY SEARCH
// ============================================================================

export const searchPharmacies = async (req, res) => {
  try {
    const userId = requireUser(req);
    const myPharmacyId = await getUserPharmacyId(userId);
    const { q } = req.query;
    if (!q || String(q).trim().length < 2) return res.json([]);
    const query = String(q).trim();

    const result = await pool.query(
      `SELECT
         p.id, p.pharmacy_name, p.address, p.npi_number, p.ncpdp_number,
         p.pharmacist_name, u.email
       FROM pharmacy_details p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id != COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')
         AND (
           p.pharmacy_name ILIKE $2
           OR p.npi_number = $3
           OR p.ncpdp_number = $3
         )
       LIMIT 10`,
      [myPharmacyId, `%${query}%`, query],
    );

    return res.json(result.rows);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("searchPharmacies error:", err);
    return res.status(500).json({ error: err.message });
  }
};
