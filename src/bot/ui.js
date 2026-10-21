
 // ============================================================
 // SA LIVE BOT UI
 // Consistent Telegram message cards for SA LIVE.
 // ============================================================

export const SA_LIVE = {
  name: "SA LIVE",
  tagline: "MEET • TALK • CONNECT",
  footer: "SA LIVE — More than just a call.",
};

function safeText(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .slice(0, maxLength);
}

// ============================================================
// MAIN HEADER
// ============================================================

export function brandHeader(title, subtitle = "") {
  let message = `🟢 *${SA_LIVE.name}*\n\n`;
  message += `*${safeText(title, 150)}*`;

  if (subtitle) {
    message += `\n\n${safeText(subtitle)}`;
  }

  return message;
}

// ============================================================
// SECTION CARD
// ============================================================

export function sectionCard({
  icon = "🟢",
  title,
  lines = [],
  footer = true,
}) {
  let message = `${icon} *${safeText(title, 150)}*\n\n`;

  if (Array.isArray(lines) && lines.length > 0) {
    message += lines.map((line) => safeText(line)).join("\n\n");
  }

  if (footer) {
    message += `\n\n━━━━━━━━━━━━━━━━━━\n_${SA_LIVE.footer}_`;
  }

  return message;
}

// ============================================================
// SUCCESS CARD
// ============================================================

export function successCard(title, message) {
  return (
    `✅ *${SA_LIVE.name}*\n\n` +
    `*${safeText(title, 150)}*\n\n` +
    `${safeText(message)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// ERROR CARD
// ============================================================

export function errorCard(title, message) {
  return (
    `❌ *${SA_LIVE.name}*\n\n` +
    `*${safeText(title, 150)}*\n\n` +
    `${safeText(message)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// WARNING CARD
// ============================================================

export function warningCard(title, message) {
  return (
    `⚠️ *${SA_LIVE.name}*\n\n` +
    `*${safeText(title, 150)}*\n\n` +
    `${safeText(message)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// INFO CARD
// ============================================================

export function infoCard(title, message) {
  return (
    `ℹ️ *${SA_LIVE.name}*\n\n` +
    `*${safeText(title, 150)}*\n\n` +
    `${safeText(message)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// VERIFICATION CARD
// ============================================================

export function verificationCard({
  status = "pending",
  message = "",
}) {
  const statusMap = {
    pending: "🟡 Pending",
    approved: "🟢 Approved",
    rejected: "🔴 Rejected",
  };

  return (
    `🛡️ *SA LIVE VERIFICATION*\n\n` +
    `Complete verification before connecting with a host.\n\n` +
    `*Current status:*\n` +
    `${statusMap[status] || "🟡 Pending"}\n\n` +
    `${safeText(message)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// BALANCE CARD
// ============================================================

export function balanceCard(minutes) {
  const availableMinutes = Number.isFinite(Number(minutes))
    ? Math.max(0, Number(minutes))
    : 0;

  return (
    `💰 *SA LIVE BALANCE*\n\n` +
    `Your available time:\n\n` +
    `⏱️ *${availableMinutes} minutes*\n\n` +
    `Need more time?\n` +
    `Use *Buy Minutes* from the main menu.\n\n` +
    `Minutes are added after your payment is successfully verified.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// PROFILE CARD
// ============================================================

export function profileCard({
  name,
  username,
  verification,
  minutes,
}) {
  const availableMinutes = Number.isFinite(Number(minutes))
    ? Math.max(0, Number(minutes))
    : 0;

  return (
    `👤 *SA LIVE PROFILE*\n\n` +
    `*Name*\n${safeText(name || "Not set", 100)}\n\n` +
    `*Telegram*\n@${safeText(username || "Not set", 64)}\n\n` +
    `*Verification*\n${safeText(verification || "Pending", 50)}\n\n` +
    `*Available minutes*\n⏱️ ${availableMinutes} minutes\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// SEARCHING CARD
// ============================================================

export function searchingCard() {
  return (
    `🔎 *SA LIVE MATCHING*\n\n` +
    `*FINDING SOMEONE...*\n\n` +
    `We're looking for an available host for you.\n\n` +
    `🟢 Checking availability...\n` +
    `🟢 Finding an available connection...\n\n` +
    `Please wait...\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// HOST FOUND CARD
// ============================================================

export function hostFoundCard() {
  return (
    `🟢 *SA LIVE MATCH FOUND*\n\n` +
    `*HOST FOUND*\n\n` +
    `Your connection has been found.\n\n` +
    `🎥 Preparing your private video room...\n` +
    `🔐 Your session will be private.\n\n` +
    `Please wait...\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// NO HOST CARD
// ============================================================

export function noHostCard() {
  return (
    `🕐 *SA LIVE MATCHING*\n\n` +
    `*NO HOST AVAILABLE*\n\n` +
    `There is currently no available host.\n\n` +
    `Please try again shortly.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// CALL CARD
// ============================================================

export function callCard({
  roomUrl = null,
  minutes = 0,
}) {
  const availableMinutes = Number.isFinite(Number(minutes))
    ? Math.max(0, Number(minutes))
    : 0;

  let message = `📞 *SA LIVE CALL*\n\n`;
  message += `🟢 *Connection ready*\n\n`;
  message += `Available time:\n⏱️ *${availableMinutes} minutes*\n\n`;

  if (roomUrl) {
    message += `🎥 *Your private video room is ready.*\n\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━\n_${SA_LIVE.footer}_`;

  return message;
}

// ============================================================
// PAYMENT CARD — PAYFAST
// ============================================================

export function paymentCard({
  packageName,
  amount,
  minutes,
}) {
  const safeAmount = Number.isFinite(Number(amount))
    ? Math.max(0, Number(amount)).toFixed(2)
    : "0.00";

  const safeMinutes = Number.isFinite(Number(minutes))
    ? Math.max(0, Number(minutes))
    : 0;

  return (
    `💳 *SA LIVE PAYMENT*\n\n` +
    `*${safeText(packageName || "Minutes package", 100)}*\n\n` +
    `💵 Price: *R${safeAmount}*\n` +
    `⏱️ Minutes: *${safeMinutes}*\n\n` +
    `Your payment will be securely processed through PayFast.\n\n` +
    `🔐 Your minutes will only be credited after your payment is successfully verified.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}

// ============================================================
// PAYMENT SUCCESS
// ============================================================

export function paymentSuccessCard({
  minutes,
  balance = null,
}) {
  const purchasedMinutes = Number.isFinite(Number(minutes))
    ? Math.max(0, Number(minutes))
    : 0;

  let message = `✅ *SA LIVE PAYMENT SUCCESSFUL*\n\n`;
  message += `Your payment has been verified.\n\n`;
  message += `Minutes added:\n⏱️ *${purchasedMinutes} minutes*\n`;

  if (balance !== null && Number.isFinite(Number(balance))) {
    message += `\n💰 New balance:\n⏱️ *${Math.max(0, Number(balance))} minutes*\n`;
  }

  message += `\nYou can now use your available minutes to request a call.\n\n`;
  message += `━━━━━━━━━━━━━━━━━━\n_${SA_LIVE.footer}_`;

  return message;
}

// ============================================================
// CALL HISTORY CARD
// ============================================================

export function callHistoryCard(calls = []) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return (
      `📋 *SA LIVE CALL HISTORY*\n\n` +
      `You don't have any completed calls yet.\n\n` +
      `Start your first connection from *Find Someone*.\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `_${SA_LIVE.footer}_`
    );
  }

  let message = `📋 *SA LIVE CALL HISTORY*\n\n`;

  calls.slice(0, 20).forEach((call, index) => {
    const seconds = Math.max(0, Number(call.durationSeconds) || 0);
    const minutes = Math.max(0, Number(call.minutesUsed) || 0);

    message += `*${index + 1}.* ${seconds} seconds\n`;
    message += `⏱️ ${minutes} minutes used\n\n`;
  });

  message += `━━━━━━━━━━━━━━━━━━\n_${SA_LIVE.footer}_`;

  return message;
}

// ============================================================
// ADMIN CARD
// ============================================================

export function adminCard({
  pending = 0,
}) {
  const pendingCount = Number.isFinite(Number(pending))
    ? Math.max(0, Number(pending))
    : 0;

  return (
    `👑 *SA LIVE ADMIN*\n\n` +
    `*Verification Dashboard*\n\n` +
    `🔐 Pending requests:\n` +
    `*${pendingCount}*\n\n` +
    `Use the verification management tools to review requests.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}
