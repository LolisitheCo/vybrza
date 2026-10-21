import "dotenv/config";
import path from "node";
import { Telegraf } from "telegraf";

import {
startHostApplication,
submitHostApplicationEmail,
getPendingHostApplications,
approveHostApplication,
rejectHostApplication,
getHostApplicationStatus,
} from "../services/hostApplicationService.js";

import {
getOrCreateUser,
submitVerification,
} from "../services/userService.js";

import {
getPendingVerificationUsers,
approveUser,
rejectUser,
} from "../services/adminService.js";

import { registerPaymentHandlers } from "./paymentBot.js";

import { matchUserToHost } from "../services/matchingService.js";
import { mainMenu } from "./menu.js";

import {
balanceCard,
errorCard,
verificationCard,
profileCard,
successCard,
searchingCard,
hostFoundCard,
noHostCard,
} from "./ui.js";

// ============================================================
// CONFIGURATION
// ============================================================

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const configuredAdminId = process.env.ADMIN_TELEGRAM_ID?.trim();

if (!token) {
throw new Error(
"Missing required environment variable: TELEGRAM_BOT_TOKEN"
);
}

if (/\s/.test(token)) {
throw new Error("TELEGRAM_BOT_TOKEN has an invalid format.");
}

if (configuredAdminId && !/^\d{1,20}$/.test(configuredAdminId)) {
throw new Error(
"ADMIN_TELEGRAM_ID must be a numeric Telegram user ID."
);
}

if (!configuredAdminId) {
console.warn(
"ADMIN_TELEGRAM_ID is not configured. Admin commands will remain unavailable."
);
}

const bot = new Telegraf(token);

// ============================================================
// VERIFICATION EMAIL SESSION
// ============================================================

// Tracks users who have been asked to provide their Gmail address.
// The email itself is saved to Firestore by submitVerification().
//
// This map only tracks the temporary conversation state. It does
// not replace Firestore as the permanent source of user information.

const pendingVerificationEmails = new Map();

// ============================================================
// SECURITY HELPERS
// ============================================================

function escapeMarkdown(value) {
return String(value ?? "").replace(/([_*`[])/g, "\$1");
}

function cleanText(value, maxLength = 200) {
return String(value ?? "")
.replace(/[\u0000-\u001F\u007F]/g, " ")
.trim()
.slice(0, maxLength);
}

function isAdmin(ctx) {
if (!configuredAdminId) {
return false;
}

return String(ctx.from?.id ?? "") === configuredAdminId;
}

function validDocumentId(value) {
return (
typeof value === "string" &&
value.length >= 1 &&
value.length <= 128 &&
/^[A-Za-z0-9_-]+$/.test(value)
);
}

function normalizeGmail(value) {
if (typeof value !== "string") {
return null;
}

const email = value.trim().toLowerCase();

if (
email.length > 254 ||
!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail.com$/i.test(email) ||
email.includes("..") ||
email.startsWith(".") ||
email.includes("@.") ||
email.includes(".@") ||
email.split("@")[0].length > 64 ||
!email.split("@")[0].length
) {
return null;
}

return email;
}

async function answerCallback(ctx, text) {
try {
await ctx.answerCbQuery(text);
} catch (error) {
console.warn(
"Unable to answer Telegram callback query:",
error?.message
);
}
}

async function replyError(ctx, title, message, includeMenu = true) {
try {
await ctx.reply(errorCard(title, message), {
parse_mode: "Markdown",
...(includeMenu ? mainMenu() : {}),
});
} catch (error) {
console.error("Unable to send error message:", error?.message);
}
}

function userDisplayName(user, telegramUser) {
return cleanText(
user?.profile?.displayName ||
telegramUser?.first_name ||
"Not set",
100
);
}

// ============================================================
// WELCOME MESSAGE
// ============================================================

async function sendWelcome(ctx) {
try {
if (!ctx.from?.id) {
await ctx.reply(
"Unable to identify your Telegram account. Please try again."
);
return;
}

await getOrCreateUser(ctx.from);

const firstName = escapeMarkdown(
  cleanText(ctx.from.first_name || "there", 64)
);

const welcomeImagePath = path.resolve(
  process.cwd(),
  "assets",
  "welcome-banner.png"
);

const caption =
  `🟢 *Welcome to SA LIVE, ${firstName}!*\n\n` +
  `*Meet someone. Start talking.*\n\n` +
  `Connect with verified people, ` +
  `find someone to talk to, and enjoy ` +
  `live conversations through SA LIVE.\n\n` +
  `🛡️ Your safety and privacy matter.\n` +
  `📞 Find someone to connect with.\n` +
  `💳 Buy minutes when you need them.\n\n` +
  `*SA LIVE — More than just a call.*`;

try {
  await ctx.replyWithPhoto(
    { source: welcomeImagePath },
    {
      caption,
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
} catch (imageError) {
  console.warn(
    "Welcome image could not be sent:",
    imageError?.message
  );

  await ctx.reply(caption, {
    parse_mode: "Markdown",
    ...mainMenu(),
  });
}

} catch (error) {
console.error("Welcome handler failed:", error?.message);

try {
  await ctx.reply(
    "🟢 SA LIVE\n\nWelcome! We could not load the full menu. Please try again.",
    mainMenu()
  );
} catch (replyError) {
  console.error("Welcome fallback failed:", replyError?.message);
}

}
}

// ============================================================
// START COMMANDS
// ============================================================

bot.start(sendWelcome);
bot.hears(/^(hi|hello|hey|start|begin)$/i, sendWelcome);

// ============================================================
// REQUEST VERIFICATION
// ============================================================

bot.action("request_verification", async (ctx) => {
try {
await answerCallback(ctx);

const user = await getOrCreateUser(ctx.from);

if (user.verificationStatus === "approved") {
  await ctx.reply(
    verificationCard({
      status: "approved",
      message:
        "Your account has already been approved.\n\n" +
        "🎉 You have access to SA LIVE.\n\n" +
        `Current balance: ${Math.max(
          0,
          Number(user.minutes) || 0
        )} minutes`,
    }),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

if (
  user.verificationStatus === "pending" &&
  user.verification?.submittedAt
) {
  await ctx.reply(
    verificationCard({
      status: "pending",
      message:
        "Your verification request has already been submitted.\n\n" +
        "An administrator will review your account.\n\n" +
        "Once approved, you can purchase minutes and use SA LIVE.",
    }),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

const isResubmission = user.verificationStatus === "rejected";

await ctx.reply(
  verificationCard({
    status: isResubmission ? "rejected" : "pending",
    message: isResubmission
      ? "Your previous verification request was not approved.\n\n" +
        "You may submit another request for review.\n\n" +
        "Please provide your Gmail address to continue."
      : "Verify your SA LIVE account to continue.\n\n" +
        "Please provide your Gmail address. We will save it to your account for PayFast payments, so you won't need to enter it again at checkout.",
  }),
  {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: isResubmission
              ? "🔄 Submit Again"
              : "✅ Submit Verification Request",
            callback_data: "submit_verification",
          },
        ],
        [
          {
            text: "⬅️ Back to Menu",
            callback_data: "back_to_main",
          },
        ],
      ],
    },
  }
);

} catch (error) {
console.error("Verification request failed:", error?.message);

await replyError(
  ctx,
  "VERIFICATION ERROR",
  "Unable to open verification right now."
);

}
});

// ============================================================
// SUBMIT VERIFICATION — ASK FOR GMAIL
// ============================================================

bot.action("submit_verification", async (ctx) => {
try {
await answerCallback(ctx);

const user = await getOrCreateUser(ctx.from);

if (user.verificationStatus === "approved") {
  await ctx.reply(
    successCard(
      "ACCOUNT ALREADY VERIFIED",
      "Your SA LIVE account has already been approved."
    ),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

if (
  user.verificationStatus === "pending" &&
  user.verification?.submittedAt
) {
  await ctx.reply(
    verificationCard({
      status: "pending",
      message:
        "Your verification request has already been submitted.\n\n" +
        "Please wait for administrator review.",
    }),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

// If the user already has an email saved, reuse it rather than
// asking for the same address again.
if (user.paymentEmail) {
  const result = await submitVerification(
    user.id,
    user.paymentEmail
  );

  await ctx.reply(
    verificationCard({
      status: result.verificationStatus,
      message: result.alreadyApproved
        ? "Your account has already been approved."
        : "Your verification request has been submitted successfully.\n\n" +
          `Gmail saved: ${result.email}\n\n` +
          "An administrator will review your account.",
    }),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

pendingVerificationEmails.set(String(ctx.from.id), {
  userId: user.id,
  startedAt: Date.now(),
});

await ctx.reply(
  "📧 SA LIVE VERIFICATION\n\n" +
    "Please send the Gmail address you want associated with your SA LIVE account.\n\n" +
    "Example: yourname@gmail.com\n\n" +
    "This address will be saved to your account and reused for PayFast checkout. You won't need to enter it again when buying minutes.\n\n" +
    "🔒 Never send your Gmail password.\n\n" +
    "Send your Gmail address in your next message."
);

} catch (error) {
console.error("Verification submission setup failed:", error?.message);

await replyError(
  ctx,
  "SUBMISSION FAILED",
  "Unable to start verification right now. Please try again."
);

}
});

// ============================================================
// CANCEL VERIFICATION EMAIL ENTRY
// ============================================================

bot.command("cancelverification", async (ctx) => {
pendingVerificationEmails.delete(String(ctx.from.id));

await ctx.reply(
"Verification email entry cancelled.\n\n" +
"You can start again from Request Verification.",
mainMenu()
);
});

// ============================================================
// PROFILE
// ============================================================

bot.action("profile", async (ctx) => {
try {
await answerCallback(ctx);

const user = await getOrCreateUser(ctx.from);

const verification =
  user.verificationStatus === "approved"
    ? "🟢 Approved"
    : user.verificationStatus === "rejected"
      ? "🔴 Rejected"
      : "🟡 Pending";

await ctx.reply(
  profileCard({
    name: escapeMarkdown(userDisplayName(user, ctx.from)),
    username: escapeMarkdown(
      cleanText(user.username || ctx.from.username || "Not set", 64)
    ),
    verification,
    minutes: Math.max(0, Number(user.minutes) || 0),
  }),
  {
    parse_mode: "Markdown",
    ...mainMenu(),
  }
);

} catch (error) {
console.error("Profile handler failed:", error?.message);

await replyError(
  ctx,
  "PROFILE ERROR",
  "Unable to load your profile right now."
);

}
});

// ============================================================
// BALANCE
// ============================================================

bot.action("balance", async (ctx) => {
try {
await answerCallback(ctx);

const user = await getOrCreateUser(ctx.from);
const minutes = Math.max(0, Number(user.minutes) || 0);

await ctx.reply(balanceCard(minutes), {
  parse_mode: "Markdown",
  ...mainMenu(),
});

} catch (error) {
console.error("Balance handler failed:", error?.message);

await replyError(
  ctx,
  "BALANCE ERROR",
  "Unable to load your balance right now."
);

}
});

// ============================================================
// FIND SOMEONE
// ============================================================

bot.action("find_someone", async (ctx) => {
try {
await answerCallback(ctx);

const user = await getOrCreateUser(ctx.from);

if (user.verificationStatus !== "approved") {
  const status =
    user.verificationStatus === "rejected"
      ? "rejected"
      : "pending";

  await ctx.reply(
    verificationCard({
      status,
      message:
        "Your account has not been approved yet.\n\n" +
        "Please complete verification before requesting a call.",
    }),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

if (
  !Number.isFinite(Number(user.minutes)) ||
  Number(user.minutes) <= 0
) {
  await ctx.reply(balanceCard(0), {
    parse_mode: "Markdown",
    ...mainMenu(),
  });
  return;
}

if (user.activeCallId) {
  await ctx.reply(
    errorCard(
      "CALL ALREADY ACTIVE",
      "You already have an active call. Finish your current call before requesting another one."
    ),
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
  return;
}

await ctx.reply(searchingCard(), {
  parse_mode: "Markdown",
});

const result = await matchUserToHost(user.id);

if (!result?.matched) {
  await ctx.reply(noHostCard(), {
    parse_mode: "Markdown",
    ...mainMenu(),
  });
  return;
}

await ctx.reply(hostFoundCard(), {
  parse_mode: "Markdown",
});

await ctx.reply(
  "🎥 *SA LIVE VIDEO ROOM*\n\n" +
    "Your host has been matched successfully.\n\n" +
    "🔐 Your private room is being prepared.\n\n" +
    "The video room generation system must be connected before a real call can begin.\n\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "_SA LIVE — More than just a call._",
  {
    parse_mode: "Markdown",
    ...mainMenu(),
  }
);

} catch (error) {
console.error("Matching request failed:", error?.message);

await replyError(
  ctx,
  "MATCHING ERROR",
  "Unable to find an available host right now. Please try again."
);

}
});

// ============================================================
// CALL HISTORY
// ============================================================

bot.action("call_history", async (ctx) => {
try {
await answerCallback(ctx);

await ctx.reply(
  "📋 *SA LIVE CALL HISTORY*\n\n" +
    "Call history will appear here when completed calls are saved by the backend.\n\n" +
    "Start a connection from *Find Someone*.\n\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "_SA LIVE — More than just a call._",
  {
    parse_mode: "Markdown",
    ...mainMenu(),
  }
);

} catch (error) {
console.error("Call history handler failed:", error?.message);

await replyError(
  ctx,
  "CALL HISTORY ERROR",
  "Unable to load your call history right now."
);

}
});

// ============================================================
// BACK TO MAIN MENU
// ============================================================

bot.action("back_to_main", async (ctx) => {
try {
await answerCallback(ctx);

// Do not leave an old verification email prompt active.
pendingVerificationEmails.delete(String(ctx.from.id));

await ctx.reply(
  "🟢 *SA LIVE*\n\n" +
    "*Main Menu*\n\n" +
    "Choose an option below to continue.\n\n" +
    "_MEET • TALK • CONNECT_",
  {
    parse_mode: "Markdown",
    ...mainMenu(),
  }
);

} catch (error) {
console.error("Main menu handler failed:", error?.message);
}
});

// ============================================================
// ADMIN: VERIFICATION DASHBOARD
// ============================================================

bot.command("admin", async (ctx) => {
try {
if (!isAdmin(ctx)) {
await ctx.reply("You are not authorized to access the admin panel.");
return;
}

const pendingUsers = await getPendingVerificationUsers();

await ctx.reply(
  [
    "SA LIVE ADMIN",
    "",
    "Verification Dashboard",
    "",
    `Pending verification requests: ${pendingUsers.length}`,
    "",
    "Use /verify_pending to review pending users.",
    "Use /host_pending to review host applications.",
  ].join("\n")
);

} catch (error) {
console.error("Admin dashboard failed:", error?.message);

await ctx.reply("Unable to load the admin panel. Please try again.");

}
});

// ============================================================
// ADMIN: VIEW PENDING VERIFICATIONS
// ============================================================

bot.command("verify_pending", async (ctx) => {
try {
if (!isAdmin(ctx)) {
await ctx.reply("❌ You are not authorized.");
return;
}

const pendingUsers = await getPendingVerificationUsers();

if (!Array.isArray(pendingUsers) || pendingUsers.length === 0) {
  await ctx.reply("✅ There are no pending verification requests.");
  return;
}

await ctx.reply(
  `🔐 SA LIVE VERIFICATIONS\n\nFound ${pendingUsers.length} pending request(s).`
);

for (const user of pendingUsers) {
  if (!validDocumentId(String(user.id ?? ""))) {
    console.warn(
      "Skipping verification record with invalid document ID."
    );
    continue;
  }

  const displayName = cleanText(
    user.profile?.displayName || "Unknown",
    100
  );

  const username = user.username
    ? `@${cleanText(user.username, 64)}`
    : "No username";

  const email = cleanText(
    user.paymentEmail || "Gmail not provided",
    254
  );

  await ctx.reply(
    "👤 VERIFICATION REQUEST\n\n" +
      `Name: ${displayName}\n` +
      `Gmail: ${email}\n` +
      `Telegram: ${username}\n` +
      `Telegram ID: ${cleanText(user.telegramId || user.id, 32)}\n` +
      "Status: Pending",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Approve",
              callback_data: `approve_verification:${user.id}`,
            },
            {
              text: "❌ Reject",
              callback_data: `reject_verification:${user.id}`,
            },
          ],
        ],
      },
    }
  );
}

} catch (error) {
console.error(
"Pending verification listing failed:",
error?.message
);

await ctx.reply("⚠️ Unable to load verification requests.");

}
});

// ============================================================
// ADMIN: APPROVE VERIFICATION
// ============================================================

bot.action(
/^approve_verification:([A-Za-z0-9_-]{1,128})$/,
async (ctx) => {
try {
if (!isAdmin(ctx)) {
await answerCallback(ctx, "Not authorized.");
return;
}

  const userId = ctx.match[1];

  await answerCallback(ctx, "Processing approval...");

  const result = await approveUser(userId, String(ctx.from.id));

  if (result?.alreadyApproved) {
    await ctx.reply(
      "ℹ️ USER ALREADY VERIFIED\n\n" +
        `Current balance: ${Math.max(
          0,
          Number(result.minutes) || 0
        )} minutes`
    );
    return;
  }

  await ctx.reply(
    "✅ USER VERIFIED\n\n" +
      "The user has been approved.\n\n" +
      "No free minutes were added.\n\n" +
      `Current balance: ${Math.max(
        0,
        Number(result?.minutes) || 0
      )} minutes`
  );
} catch (error) {
  console.error("Approve verification failed:", error?.message);

  await ctx.reply(
    "⚠️ Unable to approve this user. Please check the request and try again."
  );
}

}
);

// ============================================================
// ADMIN: REJECT VERIFICATION
// ============================================================

bot.action(
/^reject_verification:([A-Za-z0-9_-]{1,128})$/,
async (ctx) => {
try {
if (!isAdmin(ctx)) {
await answerCallback(ctx, "Not authorized.");
return;
}

  await answerCallback(ctx, "Processing rejection...");

  await rejectUser(ctx.match[1], String(ctx.from.id));

  await ctx.reply(
    "❌ VERIFICATION REJECTED\n\nThe user's verification request has been rejected."
  );
} catch (error) {
  console.error("Reject verification failed:", error?.message);

  await ctx.reply("⚠️ Unable to reject this user.");
}

}
);

// ============================================================
// HOST: START APPLICATION
// ============================================================

bot.command("host", async (ctx) => {
const args = (ctx.message?.text || "")
.trim()
.split(/\s+/)
.slice(1);

if (args.length !== 1 || args[0].toLowerCase() !== "application") {
await ctx.reply(
"To apply to become a host, use:\n\n/host application"
);
return;
}

try {
const result = await startHostApplication(ctx.from);

if (result.status === "approved") {
  await ctx.reply("✅ Your host application is already approved.");
  return;
}

if (result.status === "pending") {
  await ctx.reply(
    "⏳ Your host application is already awaiting administrator approval."
  );
  return;
}

await ctx.reply(
  "🎤 SA LIVE HOST APPLICATION\n\n" +
    "Please send the email address you will use for your SA LIVE website account.\n\n" +
    "Do not send your password here. Create your account through the website signup page.\n\n" +
    "Host access remains pending until an administrator approves your application."
);

} catch (error) {
console.error("Start host application failed:", error?.message);

await ctx.reply(
  "Unable to start your application right now. Please try again."
);

}
});

// ============================================================
// VERIFICATION EMAIL INPUT
// ============================================================

// This handler must appear BEFORE the host email handler.
// Otherwise, a Gmail message intended for verification could be
// interpreted as a host application email.

bot.on("text", async (ctx, next) => {
const telegramId = String(ctx.from?.id ?? "");
const text = ctx.message?.text?.trim() || "";

if (!text || text.startsWith("/")) {
return next();
}

const pending = pendingVerificationEmails.get(telegramId);

if (!pending) {
return next();
}

try {
const email = normalizeGmail(text);

if (!email) {
  await ctx.reply(
    "❌ That doesn't look like a valid Gmail address.\n\n" +
      "Please send an address ending in @gmail.com.\n\n" +
      "Example: yourname@gmail.com\n\n" +
      "To cancel, send /cancelverification."
  );
  return;
}

// Remove the temporary state while processing this submission.
// Restore it if the database operation fails.
pendingVerificationEmails.delete(telegramId);

const result = await submitVerification(pending.userId, email);

if (result.alreadyApproved) {
  await ctx.reply(
    "✅ Your account has already been approved.\n\n" +
      "Your saved Gmail can be used for PayFast checkout.",
    mainMenu()
  );
  return;
}

await ctx.reply(
  "✅ VERIFICATION REQUEST SUBMITTED\n\n" +
    `Gmail: ${cleanText(result.email, 254)}\n\n` +
    "Your Gmail has been saved to your SA LIVE account.\n\n" +
    "An administrator will review your verification request.\n\n" +
    "Once approved, you can buy minutes using PayFast without entering your email again.",
  mainMenu()
);

} catch (error) {
pendingVerificationEmails.set(telegramId, pending);

console.error(
  "Verification Gmail submission failed:",
  error?.message
);

await ctx.reply(
  "⚠️ We couldn't save your Gmail or submit verification right now.\n\n" +
    "Your request has not been confirmed. Please try sending your Gmail again."
);

}
});

// ============================================================
// HOST: COLLECT APPLICATION EMAIL
// ============================================================

bot.on("text", async (ctx, next) => {
const text = ctx.message?.text?.trim() || "";

if (!text || text.startsWith("/")) {
return next();
}

try {
const result = await submitHostApplicationEmail(
ctx.from.id,
text
);

if (result.status === "already_host") {
  await ctx.reply("✅ This account already has host access.");
  return;
}

if (result.status === "approved") {
  await ctx.reply("✅ Your host application is already approved.");
  return;
}

const signupMessage = result.firebaseAccountExists
  ? "Your Firebase account already exists. Make sure you can sign in to the website with this email."
  : "Create your Firebase account on the SA LIVE website using this email and choose your password there.";

await ctx.reply(
  "✅ HOST APPLICATION SUBMITTED\n\n" +
    `Email: ${cleanText(result.email, 254)}\n\n` +
    `${signupMessage}\n\n` +
    "⏳ Your application is pending administrator approval. Host access will only be enabled after approval."
);

} catch (error) {
if (
error?.message ===
"Please start with /host application first."
) {
return next();
}

console.error(
  "Host application email submission failed:",
  error?.message
);

await ctx.reply(
  "That email could not be submitted. Please enter a valid email address, or start again with /host application."
);

}
});

// ============================================================
// ADMIN: VIEW PENDING HOST APPLICATIONS
// ============================================================

bot.command("host_pending", async (ctx) => {
if (!isAdmin(ctx)) {
await ctx.reply("❌ You are not authorized.");
return;
}

try {
const pending = await getPendingHostApplications();

if (!Array.isArray(pending) || pending.length === 0) {
  await ctx.reply("✅ There are no pending host applications.");
  return;
}

await ctx.reply(
  `🎤 Pending host applications: ${pending.length}`
);

for (const application of pending) {
  if (!validDocumentId(String(application.id ?? ""))) {
    console.warn(
      "Skipping host application with invalid document ID."
    );
    continue;
  }

  await ctx.reply(
    "HOST APPLICATION\n\n" +
      `Name: ${cleanText(
        `${application.firstName || ""} ${application.lastName || ""}`,
        120
      )}\n` +
      `Email: ${cleanText(application.email || "", 254)}\n` +
      `Telegram: ${
        application.telegramUsername
          ? `@${cleanText(application.telegramUsername, 64)}`
          : "Not set"
      }\n` +
      "Status: Pending",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Approve",
              callback_data: `approve_host:${application.id}`,
            },
            {
              text: "❌ Reject",
              callback_data: `reject_host:${application.id}`,
            },
          ],
        ],
      },
    }
  );
}

} catch (error) {
console.error(
"Pending host applications failed:",
error?.message
);

await ctx.reply("Unable to load pending host applications.");

}
});

// ============================================================
// ADMIN: APPROVE HOST APPLICATION
// ============================================================

bot.action(
/^approve_host:([A-Za-z0-9_-]{1,128})$/,
async (ctx) => {
if (!isAdmin(ctx)) {
await answerCallback(ctx, "Not authorized.");
return;
}

try {
  await answerCallback(ctx, "Processing host approval...");

  const result = await approveHostApplication(
    ctx.match[1],
    String(ctx.from.id)
  );

  await ctx.reply(
    "✅ HOST APPROVED\n\n" +
      `Email: ${cleanText(result.email || "", 254)}\n\n` +
      "Host access has been assigned. The host may need to sign out and sign in again to refresh their Firebase token."
  );
} catch (error) {
  console.error(
    "Approve host application failed:",
    error?.message
  );

  await ctx.reply(
    "⚠️ Host approval failed. Confirm that the applicant has created their Firebase account with the submitted email, then try again."
  );
}

}
);

// ============================================================
// ADMIN: REJECT HOST APPLICATION
// ============================================================

bot.action(
/^reject_host:([A-Za-z0-9_-]{1,128})$/,
async (ctx) => {
if (!isAdmin(ctx)) {
await answerCallback(ctx, "Not authorized.");
return;
}

try {
  await answerCallback(ctx, "Processing rejection...");

  await rejectHostApplication(
    ctx.match[1],
    String(ctx.from.id)
  );

  await ctx.reply(
    "❌ The host application has been rejected."
  );
} catch (error) {
  console.error(
    "Reject host application failed:",
    error?.message
  );

  await ctx.reply("Unable to reject this application.");
}

}
);

// ============================================================
// HOST: CHECK APPLICATION STATUS
// ============================================================

bot.command("hoststatus", async (ctx) => {
try {
const result = await getHostApplicationStatus(ctx.from.id);

if (result.status === "not_submitted") {
  await ctx.reply(
    "You have not applied yet. Start with /host application"
  );
  return;
}

const labels = {
  pending: "⏳ Pending administrator approval",
  approved: "✅ Approved",
  rejected: "❌ Rejected",
};

await ctx.reply(
  "HOST APPLICATION STATUS\n\n" +
    `Status: ${labels[result.status] || "Unknown"}\n` +
    `Email: ${cleanText(result.email || "Not provided", 254)}`
);

} catch (error) {
console.error(
"Host application status failed:",
error?.message
);

await ctx.reply(
  "Unable to check your host application status right now."
);

}
});

// ============================================================
// UNKNOWN TEXT MESSAGE
// ============================================================

bot.on("text", async (ctx) => {
try {
const text = ctx.message?.text?.trim().toLowerCase();

if (!text) {
  return;
}

if (/^(hi|hello|hey|start|begin)$/i.test(text)) {
  return;
}

await ctx.reply(
  "🟢 *SA LIVE*\n\n" +
    "I didn't recognise that message.\n\n" +
    "Use the buttons below to continue.",
  {
    parse_mode: "Markdown",
    ...mainMenu(),
  }
);

} catch (error) {
console.error(
"Unknown text handler failed:",
error?.message
);
}
});

// ============================================================
// PAYMENT HANDLERS
// ============================================================

// Payment validation, PayFast signature checks, payment verification,
// and minute crediting remain in the existing payment module.

registerPaymentHandlers(bot);

// ============================================================
// TELEGRAM ERROR HANDLER
// ============================================================

bot.catch((error, ctx) => {
console.error("Telegram bot handler error:", {
updateType: ctx?.updateType || "unknown",
message: error?.message || "Unknown Telegram error",
});
});

// ============================================================
// EXPORT
// ============================================================

export { bot };