// import express from "express";
// import {
//   // Listings
//   getListings,
//   createListing,
//   updateListing,
//   deleteListing,
//   reportListing,
//   // Agreement
//   getAgreementStatus,
//   acceptAgreement,
//   // Connect request
//   sendConnectRequest,
//   // Groups
//   getMyGroups,
//   createGroup,
//   getGroupDetail,
//   inviteToGroup,
//   generateGroupInviteCode,
//   joinGroupByCode,
//   leaveGroup,
//   removeGroupMember,
//   deleteGroup,
//   // Invitations
//   getMyInvitations,
//   acceptInvitation,
//   declineInvitation,
//   // Pharmacy search
//   searchPharmacies,
// } from "../controllers/inventoryView.controller.js";

// const router = express.Router();

// // ── Listings ────────────────────────────────────────────────
// router.get("/listings", getListings);
// router.post("/listings", createListing);
// router.patch("/listings/:id", updateListing);
// router.delete("/listings/:id", deleteListing);
// router.post("/listings/:id/report", reportListing);

// // ── Agreement ───────────────────────────────────────────────
// router.get("/agreement/status", getAgreementStatus);
// router.post("/agreement/accept", acceptAgreement);

// // ── Connect request ─────────────────────────────────────────
// router.post("/connect-request", sendConnectRequest);

// // ── Pharmacy search (used to invite by name/NPI) ────────────
// // Must come BEFORE any /groups/:id routes so it matches first
// router.get("/pharmacies/search", searchPharmacies);

// // ── Groups ──────────────────────────────────────────────────
// // IMPORTANT: static routes must come BEFORE /:id wildcard routes
// router.get("/groups", getMyGroups);
// router.post("/groups", createGroup);
// router.post("/groups/join-by-code", joinGroupByCode);   // static — must come before /:id
// router.get("/groups/:id", getGroupDetail);
// router.post("/groups/:id/invite", inviteToGroup);
// router.post("/groups/:id/invite-code", generateGroupInviteCode);
// router.post("/groups/:id/leave", leaveGroup);
// router.delete("/groups/:id/members/:memberPharmacyId", removeGroupMember);
// router.delete("/groups/:id", deleteGroup);

// // ── Invitations inbox ───────────────────────────────────────
// router.get("/invitations", getMyInvitations);
// router.post("/invitations/:id/accept", acceptInvitation);
// router.post("/invitations/:id/decline", declineInvitation);

// export default router;

import express from "express";
import {
  // Listings
  getListings,
  createListing,
  updateListing,
  deleteListing,
  reportListing,
  // Agreement
  getAgreementStatus,
  acceptAgreement,
  // Connect request
  sendConnectRequest,
  // Groups
  getMyGroups,
  discoverGroups,
  createGroup,
  updateGroup,
  getGroupDetail,
  inviteToGroup,
  requestJoinGroup,
  generateGroupInviteCode,
  joinGroupByCode,
  leaveGroup,
  removeGroupMember,
  deleteGroup,
  // Invitations
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
  // Pharmacy search
  searchPharmacies,
} from "../controllers/inventoryView.controller.js";

const router = express.Router();

// ── Listings ────────────────────────────────────────────────
router.get("/listings", getListings);
router.post("/listings", createListing);
router.patch("/listings/:id", updateListing);
router.delete("/listings/:id", deleteListing);
router.post("/listings/:id/report", reportListing);

// ── Agreement ───────────────────────────────────────────────
router.get("/agreement/status", getAgreementStatus);
router.post("/agreement/accept", acceptAgreement);

// ── Connect request ─────────────────────────────────────────
router.post("/connect-request", sendConnectRequest);

// ── Pharmacy search (used to invite by name/NPI) ────────────
router.get("/pharmacies/search", searchPharmacies);

// ── Groups ──────────────────────────────────────────────────
// CRITICAL: static routes must come BEFORE /:id wildcard routes
router.get("/groups", getMyGroups);
router.post("/groups", createGroup);
router.get("/groups/discover", discoverGroups); // NEW
router.post("/groups/join-by-code", joinGroupByCode);
router.get("/groups/:id", getGroupDetail);
router.patch("/groups/:id", updateGroup); // NEW
router.delete("/groups/:id", deleteGroup);
router.post("/groups/:id/invite", inviteToGroup);
router.post("/groups/:id/request-join", requestJoinGroup); // NEW
router.post("/groups/:id/invite-code", generateGroupInviteCode);
router.post("/groups/:id/leave", leaveGroup);
router.delete("/groups/:id/members/:memberPharmacyId", removeGroupMember);

// ── Invitations inbox ───────────────────────────────────────
router.get("/invitations", getMyInvitations);
router.post("/invitations/:id/accept", acceptInvitation);
router.post("/invitations/:id/decline", declineInvitation);

export default router;
