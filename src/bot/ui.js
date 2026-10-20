// ============================================================
// SA LIVE BOT UI
// ============================================================
// Central place for the bot's visual style.
// Telegram controls the actual chat background, but these
// helpers keep all SA LIVE messages visually consistent.
// ============================================================


// ============================================================
// COLORS / BRAND
// ============================================================

export const SA_LIVE = {
  name: "SA LIVE",

  tagline:
    "MEET • TALK • CONNECT",

  footer:
    "SA LIVE — More than just a call.",
};


// ============================================================
// MAIN HEADER
// ============================================================

export function brandHeader(
  title,
  subtitle = ""
) {
  let message =
    `🟢 *${SA_LIVE.name}*\n\n`;

  message +=
    `*${title}*`;

  if (subtitle) {
    message +=
      `\n\n${subtitle}`;
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
  let message =
    `${icon} *${title}*\n\n`;

  if (lines.length > 0) {
    message +=
      lines.join("\n\n");
  }

  if (footer) {
    message +=
      `\n\n━━━━━━━━━━━━━━━━━━\n` +
      `_${SA_LIVE.footer}_`;
  }

  return message;
}


// ============================================================
// SUCCESS CARD
// ============================================================

export function successCard(
  title,
  message
) {
  return (
    `✅ *${SA_LIVE.name}*\n\n` +
    `*${title}*\n\n` +
    `${message}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}


// ============================================================
// ERROR CARD
// ============================================================

export function errorCard(
  title,
  message
) {
  return (
    `❌ *${SA_LIVE.name}*\n\n` +
    `*${title}*\n\n` +
    `${message}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}


// ============================================================
// WARNING CARD
// ============================================================

export function warningCard(
  title,
  message
) {
  return (
    `⚠️ *${SA_LIVE.name}*\n\n` +
    `*${title}*\n\n` +
    `${message}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}


// ============================================================
// INFO CARD
// ============================================================

export function infoCard(
  title,
  message
) {
  return (
    `ℹ️ *${SA_LIVE.name}*\n\n` +
    `*${title}*\n\n` +
    `${message}\n\n` +
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
    pending:
      "🟡 Pending",

    approved:
      "🟢 Approved",

    rejected:
      "🔴 Rejected",
  };

  return (
    `🛡️ *SA LIVE VERIFICATION*\n\n` +

    `Build trust before you connect.\n\n` +

    `*Current status:*\n` +
    `${statusMap[status] || "🟡 Pending"}\n\n` +

    `${message}\n\n` +

    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}


// ============================================================
// BALANCE CARD
// ============================================================

export function balanceCard(
  minutes
) {
  return (
    `💰 *SA LIVE BALANCE*\n\n` +

    `Your available time:\n\n` +

    `⏱️ *${minutes} minutes*\n\n` +

    `Need more time?\n` +
    `Use *Buy Minutes* from the main menu.\n\n` +

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
  return (
    `👤 *SA LIVE PROFILE*\n\n` +

    `*Name*\n` +
    `${name || "Not set"}\n\n` +

    `*Telegram*\n` +
    `@${username || "Not set"}\n\n` +

    `*Verification*\n` +
    `${verification}\n\n` +

    `*Available minutes*\n` +
    `⏱️ ${minutes || 0} minutes\n\n` +

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
    `🟢 Finding the best available connection...\n\n` +

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
  let message =
    `📞 *SA LIVE CALL*\n\n`;

  message +=
    `🟢 *Connection ready*\n\n`;

  message +=
    `Available time:\n` +
    `⏱️ *${minutes} minutes*\n\n`;

  if (roomUrl) {
    message +=
      `🎥 *Your private video room is ready.*\n\n`;
  }

  message +=
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`;

  return message;
}


// ============================================================
// PAYMENT CARD
// ============================================================

export function paymentCard({
  packageName,
  amount,
  minutes,
}) {
  return (
    `💳 *SA LIVE PAYMENT*\n\n` +

    `*${packageName}*\n\n` +

    `💵 Price: *R${amount}*\n` +
    `⏱️ Minutes: *${minutes}*\n\n` +

    `Your payment will be securely processed through Paystack.\n\n` +

    `🔐 Your minutes will only be credited after the payment is successfully verified.\n\n` +

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
  let message =
    `✅ *SA LIVE PAYMENT SUCCESSFUL*\n\n`;

  message +=
    `Your payment has been verified.\n\n`;

  message +=
    `🎉 Minutes added:\n` +
    `⏱️ *${minutes} minutes*\n`;

  if (balance !== null) {
    message +=
      `\n💰 New balance:\n` +
      `⏱️ *${balance} minutes*\n`;
  }

  message +=
    `\nYou can now use your minutes to start a call.\n\n`;

  message +=
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`;

  return message;
}


// ============================================================
// CALL HISTORY CARD
// ============================================================

export function callHistoryCard(
  calls = []
) {
  if (!calls.length) {
    return (
      `📋 *SA LIVE CALL HISTORY*\n\n` +

      `You don't have any completed calls yet.\n\n` +

      `Start your first connection from *Find Someone*.\n\n` +

      `━━━━━━━━━━━━━━━━━━\n` +
      `_${SA_LIVE.footer}_`
    );
  }

  let message =
    `📋 *SA LIVE CALL HISTORY*\n\n`;

  calls.forEach(
    (call, index) => {
      message +=
        `*${index + 1}.* ` +
        `${call.durationSeconds || 0} seconds\n`;

      message +=
        `⏱️ ${call.minutesUsed || 0} minutes used\n\n`;
    }
  );

  message +=
    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`;

  return message;
}


// ============================================================
// ADMIN CARD
// ============================================================

export function adminCard({
  pending = 0,
}) {
  return (
    `👑 *SA LIVE ADMIN*\n\n` +

    `*Verification Dashboard*\n\n` +

    `🔐 Pending requests:\n` +
    `*${pending}*\n\n` +

    `Use the verification management tools below.\n\n` +

    `━━━━━━━━━━━━━━━━━━\n` +
    `_${SA_LIVE.footer}_`
  );
}