// import { Resend } from "resend";
// import path from "path";
// import fs from "fs";

// const AGREEMENT_PDF_PATH = path.join(
//   process.cwd(),
//   "assets",
//   "AuditProRx_Network_Agreement.pdf"
// );

// let resendClient = null;
// const getClient = () => {
//   if (resendClient) return resendClient;
//   if (!process.env.RESEND_API_KEY) {
//     throw new Error("RESEND_API_KEY is not configured in .env");
//   }
//   resendClient = new Resend(process.env.RESEND_API_KEY);
//   return resendClient;
// };

// export const sendConnectRequestEmail = async ({
//   to,
//   subject,
//   body,
//   buyerName,
//   buyerEmail,
// }) => {
//   if (!to) throw new Error("Recipient email missing");

//   // Plain-text body → simple HTML for nicer rendering
//   const htmlBody = `
//     <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#0f172a; max-width:640px;">
//       <pre style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size:14px; line-height:1.6; margin:0;">${escapeHtml(body)}</pre>
//       <hr style="border:none; border-top:1px solid #e5e7eb; margin: 24px 0;"/>
//       <p style="font-size:11px; color:#64748b; margin:0;">
//   This email was generated as an inventory transfer inquiry between two pharmacies.
//   Both pharmacies are responsible for DSCSA / EPCIS compliance. Any agreement to
//   transfer drugs is bilateral and entered into directly between the two pharmacies.
// </p>
//     </div>
//   `;

//   // Build attachments — Resend takes them as base64 strings
//   const attachments = [];
//   if (fs.existsSync(AGREEMENT_PDF_PATH)) {
//     const pdfBuffer = fs.readFileSync(AGREEMENT_PDF_PATH);
//     attachments.push({
//       filename: "AuditProRx_Network_Agreement.pdf",
//       content: pdfBuffer.toString("base64"),
//     });
//     console.log("📎 Agreement PDF attached:", AGREEMENT_PDF_PATH);
//   } else {
//     console.warn("⚠️  Agreement PDF not found at:", AGREEMENT_PDF_PATH);
//   }

//   // "From" address shows the buyer's name but uses AuditProRx's verified domain.
// // "Reply-To" routes replies straight to the buyer's actual email.
// // This is the standard pattern (Calendly, Slack, LinkedIn all do this).
// const fromName = buyerName ? buyerName : "Pharmacy Network";
// const fromDomain = process.env.EMAIL_FROM || "noreply@auditprorx.com";
// // Strip any existing display name from EMAIL_FROM, keep just the address
// const fromEmailOnly = fromDomain.match(/<(.+)>/)?.[1] || fromDomain;
// const fromAddress = `${fromName} <${fromEmailOnly}>`;

// const replyTo = buyerEmail
//   ? (buyerName ? `${buyerName} <${buyerEmail}>` : buyerEmail)
//   : undefined;

// const payload = {
//   from: fromAddress,
//   to: [to],
//   subject: subject,
//   html: htmlBody,
//   text: body,
//   attachments: attachments,
// };

// // Only attach reply-to if we have a buyer email
// // Resend's SDK uses camelCase `replyTo` — NOT snake_case `reply_to`
// if (replyTo) {
//   payload.replyTo = replyTo;
// }

// console.log("📧 Sending email with payload:");
// console.log("   from:", payload.from);
// console.log("   to:", payload.to);
// console.log("   replyTo:", payload.replyTo || "(none)");
// console.log("   subject:", payload.subject);

// const { data, error } = await getClient().emails.send(payload);

//   if (error) {
//     // Resend returns errors in the response, doesn't throw — surface it as an error
//     const errMsg = `Resend error: ${error.message || JSON.stringify(error)}`;
//     console.error("❌ Resend send failed:", error);
//     throw new Error(errMsg);
//   }

//   return { messageId: data?.id || null };
// };

// function escapeHtml(s) {
//   return String(s || "")
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;");
// }

// -------------------------------------

import { Resend } from "resend";
import path from "path";
import fs from "fs";

// const AGREEMENT_PDF_PATH = path.join(
//   process.cwd(),
//   "assets",
//   "AuditProRx_Network_Agreement.pdf",
// );

let resendClient = null;
const getClient = () => {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured in .env");
  }
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
};

export const sendConnectRequestEmail = async ({
  to,
  subject,
  body,
  buyerName,
  buyerEmail,
}) => {
  if (!to) throw new Error("Recipient email missing");

  // Plain-text body → simple HTML for nicer rendering
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#0f172a; max-width:640px;">
      <pre style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size:14px; line-height:1.6; margin:0;">${escapeHtml(body)}</pre>
      <hr style="border:none; border-top:1px solid #e5e7eb; margin: 24px 0;"/>
      <p style="font-size:11px; color:#64748b; margin:0;">
  This email was generated as an inventory transfer inquiry between two pharmacies.
  Both pharmacies are responsible for DSCSA / EPCIS compliance. Any agreement to
  transfer drugs is bilateral and entered into directly between the two pharmacies.
</p>
    </div>
  `;

  // Build attachments — Resend takes them as base64 strings
  // const attachments = [];
  // if (fs.existsSync(AGREEMENT_PDF_PATH)) {
  //   const pdfBuffer = fs.readFileSync(AGREEMENT_PDF_PATH);
  //   attachments.push({
  //     filename: "AuditProRx_Network_Agreement.pdf",
  //     content: pdfBuffer.toString("base64"),
  //   });
  //   console.log("📎 Agreement PDF attached:", AGREEMENT_PDF_PATH);
  // } else {
  //   console.warn("⚠️  Agreement PDF not found at:", AGREEMENT_PDF_PATH);
  // }

  // "From" address shows the buyer's name but uses AuditProRx's verified domain.
  // "Reply-To" routes replies straight to the buyer's actual email.
  // This is the standard pattern (Calendly, Slack, LinkedIn all do this).

  const fromName = buyerName ? buyerName : "Pharmacy Network";
  const fromDomain = process.env.EMAIL_FROM || "noreply@auditprorx.com";
  const fromEmailOnly = fromDomain.match(/<(.+)>/)?.[1] || fromDomain;
  const fromAddress = `${fromName} <${fromEmailOnly}>`;

  const replyTo = buyerEmail
    ? buyerName
      ? `${buyerName} <${buyerEmail}>`
      : buyerEmail
    : undefined;

  const payload = {
    from: fromAddress,
    to: [to],
    subject: subject,
    html: htmlBody,
    text: body,
    // attachments: attachments,
  };

  // Only attach reply-to if we have a buyer email
  // Resend's SDK uses camelCase `replyTo` — NOT snake_case `reply_to`
  if (replyTo) {
    payload.replyTo = replyTo;
  }

  console.log("📧 Sending email with payload:");
  console.log("   from:", payload.from);
  console.log("   to:", payload.to);
  console.log("   replyTo:", payload.replyTo || "(none)");
  console.log("   subject:", payload.subject);

  const { data, error } = await getClient().emails.send(payload);

  if (error) {
    // Resend returns errors in the response, doesn't throw — surface it as an error
    const errMsg = `Resend error: ${error.message || JSON.stringify(error)}`;
    console.error("❌ Resend send failed:", error);
    throw new Error(errMsg);
  }

  return { messageId: data?.id || null };
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Group Invitation Email ──────────────────────────────────
export const sendGroupInvitationEmail = async ({
  to,
  groupName,
  inviterName,
  inviterPharmacy,
  message,
}) => {
  if (!to) throw new Error("Recipient email missing");

  const subject = `${inviterName} invited you to a pharmacy group on AuditProRx`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#0f172a; max-width:560px;">
      <h2 style="font-size:20px; margin:0 0 12px 0;">You've been invited to join a pharmacy group</h2>
      <p style="font-size:14px; line-height:1.6; margin:0 0 12px 0;">
        <strong>${escapeHtml(inviterName)}</strong>${
          inviterPharmacy
            ? ` from <strong>${escapeHtml(inviterPharmacy)}</strong>`
            : ""
        } invited you to join the group:
      </p>
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:16px;">
        <div style="font-size:18px; font-weight:700; color:#0f172a;">${escapeHtml(groupName)}</div>
      </div>
      ${
        message
          ? `<p style="font-size:14px; line-height:1.6; margin:0 0 12px 0; color:#475569;"><em>"${escapeHtml(message)}"</em></p>`
          : ""
      }
       <p style="font-size:14px; line-height:1.6; margin:12px 0;">
  Sign in to 
  <a
    href="https://www.auditprorx.com/auth"
    target="_blank"
    rel="noopener noreferrer"
  >
    AuditProRx
  </a>
  and head to the Inventory View → Groups tab to accept this invitation.
</p>
 
      <hr style="border:none; border-top:1px solid #e5e7eb; margin: 20px 0;"/>
      <p style="font-size:11px; color:#64748b; margin:0;">
        Pharmacy groups let trusted pharmacies share inventory listings privately within their network.
        You can decline this invitation if it wasn't expected.
      </p>
    </div>
  `;

  const fromDomain = process.env.EMAIL_FROM || "noreply@auditprorx.com";
  const fromEmailOnly = fromDomain.match(/<(.+)>/)?.[1] || fromDomain;
  const fromAddress = `AuditProRx Network <${fromEmailOnly}>`;

  // const { data, error } = await getClient().emails.send({
  //   from: fromAddress,
  //   to: [to],
  //   subject,
  //   html,
  // });

  // if (error) throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  // return { messageId: data?.id || null };

  console.log("📧 [GroupInvite] Sending via Resend:");
  console.log("   from:", fromAddress);
  console.log("   to:", to);
  console.log("   subject:", subject);

  const { data, error } = await getClient().emails.send({
    from: fromAddress,
    to: [to],
    subject,
    html,
  });

  if (error) {
    console.error("❌ [GroupInvite] Resend returned error:", error);
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }

  console.log("✅ [GroupInvite] Resend accepted, messageId:", data?.id);
  return { messageId: data?.id || null };
};
