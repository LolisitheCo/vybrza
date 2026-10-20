import { Telegraf } from "telegraf";
import dotenv from "dotenv";
import path from "path";
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

import {
  registerPaymentHandlers,
} from "./paymentBot.js";

import {
  matchUserToHost,
} from "../services/matchingService.js";

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

dotenv.config();

// ============================================================
// TELEGRAM BOT CONFIGURATION
// ============================================================

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing.");
}

const bot = new Telegraf(token);

// ============================================================
// ADMIN CHECK
// ============================================================

function isAdmin(ctx) {
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (!adminId) {
    return false;
  }

  return String(ctx.from?.id) === String(adminId);
}

// ============================================================
// WELCOME MESSAGE
// ============================================================

async function sendWelcome(ctx) {
  try {
    const telegramId = String(ctx.from.id);

    await getOrCreateUser(telegramId);

    const firstName = ctx.from.first_name || "there";

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
      console.error("Welcome image error:", imageError);

      await ctx.reply(caption, {
        parse_mode: "Markdown",
        ...mainMenu(),
      });
    }
  } catch (error) {
    console.error("Welcome error:", error);

    try {
      await ctx.reply(
        `🟢 *SA LIVE*\n\n` +
        `Welcome! Something went wrong while loading the full menu.\n\n` +
        `Please try again.`,
        {
          parse_mode: "Markdown",
          ...mainMenu(),
        }
      );
    } catch (replyError) {
      console.error("Welcome fallback error:", replyError);
    }
  }
}

// ============================================================
// /start
// ============================================================

bot.start(async (ctx) => {
  await sendWelcome(ctx);
});

// ============================================================
// START OVER WITH NORMAL TEXT
// ============================================================

bot.hears(
  /^(hi|hello|hey|start|begin)$/i,
  async (ctx) => {
    await sendWelcome(ctx);
  }
);

// ============================================================
// REQUEST VERIFICATION
// ============================================================

bot.action("request_verification", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const user = await getOrCreateUser(ctx.from);

    if (user.verificationStatus === "approved") {
      await ctx.reply(
        verificationCard({
          status: "approved",
          message:
            `Your account has already been approved.\n\n` +
            `🎉 You have access to SA LIVE.\n\n` +
            `⏱️ Available minutes: *${user.minutes || 0}*`,
        }),
        {
          parse_mode: "Markdown",
          ...mainMenu(),
        }
      );

      return;
    }

    if (user.verificationStatus === "pending") {
      const submittedAt = user.verification?.submittedAt;

      if (submittedAt) {
        await ctx.reply(
          verificationCard({
            status: "pending",
            message:
              `Your verification request has already been submitted.\n\n` +
              `🔎 An administrator is reviewing your account.\n\n` +
              `🎁 Once approved, you will receive your *5 free minutes*.`,
          }),
          {
            parse_mode: "Markdown",
            ...mainMenu(),
          }
        );

        return;
      }

      await ctx.reply(
        verificationCard({
          status: "pending",
          message:
            `Your account needs to be verified before you can start a call.\n\n` +
            `Complete the verification process provided by SA LIVE.\n\n` +
            `Once completed, submit your request for review.`,
        }),
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Submit Verification Request",
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

      return;
    }

    if (user.verificationStatus === "rejected") {
      await ctx.reply(
        verificationCard({
          status: "rejected",
          message:
            `Your previous verification request was not approved.\n\n` +
            `You may submit another request for review.`,
        }),
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Submit Again",
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

      return;
    }
  } catch (error) {
    console.error("Verification request error:", error);

    await ctx.reply(
      errorCard(
        "VERIFICATION ERROR",
        "Unable to open verification right now."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});

// ============================================================
// SUBMIT VERIFICATION
// ============================================================

bot.action("submit_verification", async (ctx) => {
  try {
    await ctx.answerCbQuery();

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

    await submitVerification(user.id);

    await ctx.reply(
      verificationCard({
        status: "pending",
        message:
          `Your verification request has been sent successfully.\n\n` +
          `🔎 An administrator will review your account.\n\n` +
          `🎁 Once approved, you will receive your *5 free minutes*.`,
      }),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Verification submission error:", error);

    await ctx.reply(
      errorCard(
        "SUBMISSION FAILED",
        "Unable to submit your verification request right now. Please try again."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});

// ============================================================
// PROFILE
// ============================================================

bot.action("profile", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const user = await getOrCreateUser(ctx.from);

    const verification =
      user.verificationStatus === "approved"
        ? "🟢 Approved"
        : user.verificationStatus === "rejected"
          ? "🔴 Rejected"
          : "🟡 Pending";

    await ctx.reply(
      profileCard({
        name:
          user.profile?.displayName ||
          ctx.from.first_name ||
          "Not set",

        username:
          user.username ||
          ctx.from.username ||
          "Not set",

        verification,
        minutes: user.minutes || 0,
      }),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Profile error:", error);

    await ctx.reply(
      errorCard(
        "PROFILE ERROR",
        "Unable to load your profile right now."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});

// ============================================================
// BALANCE
// ============================================================

bot.action("balance", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const user = await getOrCreateUser(ctx.from);
    const minutes = Number(user.minutes || 0);

    await ctx.reply(balanceCard(minutes), {
      parse_mode: "Markdown",
      ...mainMenu(),
    });
  } catch (error) {
    console.error("Balance error:", error);

    await ctx.reply(
      errorCard(
        "BALANCE ERROR",
        "Unable to load your balance right now."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});// ============================================================
// FIND SOMEONE
// ============================================================

bot.action("find_someone", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const user = await getOrCreateUser(ctx.from);

    if (user.verificationStatus !== "approved") {
      await ctx.reply(
        verificationCard({
          status:
            user.verificationStatus === "rejected"
              ? "rejected"
              : "pending",
          message:
            `Your account has not been approved yet.\n\n` +
            `Please complete verification before requesting a call.`,
        }),
        {
          parse_mode: "Markdown",
          ...mainMenu(),
        }
      );

      return;
    }

    if (Number(user.minutes || 0) <= 0) {
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
          "You already have an active call. Please finish your current call before requesting another one."
        ),
        {
          parse_mode: "Markdown",
        }
      );

      return;
    }

    await ctx.reply(searchingCard(), {
      parse_mode: "Markdown",
    });

    const result = await matchUserToHost(user.id);

    if (!result.matched) {
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
      `🎥 *SA LIVE VIDEO ROOM*\n\n` +
      `Your host has been matched successfully.\n\n` +
      `🔐 Your private room is being prepared.\n\n` +
      `The video room generation system will be connected next.\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `_SA LIVE — More than just a call._`,
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Matching request error:", error);

    await ctx.reply(
      errorCard(
        "MATCHING ERROR",
        "Unable to find an available host right now. Please try again."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});

// ============================================================
// CALL HISTORY
// ============================================================

bot.action("call_history", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    await ctx.reply(
      `📋 *SA LIVE CALL HISTORY*\n\n` +
      `You don't have any completed calls yet.\n\n` +
      `Start your first connection from *Find Someone*.\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `_SA LIVE — More than just a call._`,
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Call history error:", error);

    await ctx.reply(
      errorCard(
        "CALL HISTORY ERROR",
        "Unable to load your call history right now."
      ),
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  }
});

// ============================================================
// BACK TO MAIN MENU
// ============================================================

bot.action("back_to_main", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    await ctx.reply(
      `🟢 *SA LIVE*\n\n` +
      `*Main Menu*\n\n` +
      `Choose an option below to continue.\n\n` +
      `_MEET • TALK • CONNECT_`,
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Back to main menu error:", error);
  }
});

// ============================================================
// ADMIN PANEL
// ============================================================

bot.command("admin", async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply(
        "You are not authorized to access the admin panel."
      );

      return;
    }

    const pendingUsers = await getPendingVerificationUsers();

    const message = [
      "SA LIVE ADMIN",
      "",
      "Verification Dashboard",
      "",
      `Pending verification requests: ${pendingUsers.length}`,
      "",
      "Use /verify_pending to review pending users.",
    ].join("\n");

    await ctx.reply(message);
  } catch (error) {
    console.error("Admin command error:", error);

    await ctx.reply(
      "Unable to load the admin panel. Please try again."
    );
  }
});

// ============================================================
// VIEW PENDING VERIFICATIONS
// ============================================================

bot.command("verify_pending", async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      await ctx.reply("❌ You are not authorized.");
      return;
    }

    const pendingUsers = await getPendingVerificationUsers();

    if (pendingUsers.length === 0) {
      await ctx.reply(
        "✅ There are no pending verification requests."
      );

      return;
    }

    await ctx.reply(
      `🔐 *SA LIVE VERIFICATIONS*\n\n` +
      `Found *${pendingUsers.length}* pending request${
        pendingUsers.length === 1 ? "" : "s"
      }.`,
      {
        parse_mode: "Markdown",
      }
    );

    for (const user of pendingUsers) {
      const username = user.username
        ? `@${user.username}`
        : "No username";

      await ctx.reply(
        `👤 *VERIFICATION REQUEST*\n\n` +
        `*Name*\n` +
        `${user.profile?.displayName || "Unknown"}\n\n` +
        `*Telegram*\n` +
        `${username}\n\n` +
        `*Telegram ID*\n` +
        `${user.telegramId}\n\n` +
        `*Status*\n` +
        `🟡 Pending`,
        {
          parse_mode: "Markdown",
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
    console.error("Pending verification error:", error);

    await ctx.reply(
      "⚠️ Unable to load verification requests."
    );
  }
});// ============================================================
// APPROVE VERIFICATION
// ============================================================

bot.action(
  /^approve_verification:(.+)$/,
  async (ctx) => {
    try {
      if (!isAdmin(ctx)) {
        await ctx.answerCbQuery("Not authorized.");
        return;
      }

      await ctx.answerCbQuery("Approving user...");

      const userId = ctx.match[1];

      const result = await approveUser(
        userId,
        ctx.from.id
      );

      if (result.alreadyApproved) {
        await ctx.reply(
          `ℹ️ *USER ALREADY VERIFIED*\n\n` +
          `Current balance:\n` +
          `⏱️ *${result.minutes} minutes*`,
          {
            parse_mode: "Markdown",
          }
        );

        return;
      }

      await ctx.reply(
        `✅ *USER VERIFIED*\n\n` +
        `The user has been approved.\n\n` +
        `🎉 *5 free minutes added.*\n\n` +
        `New balance:\n` +
        `⏱️ *${result.minutes} minutes*`,
        {
          parse_mode: "Markdown",
        }
      );
    } catch (error) {
      console.error("Approve verification error:", error);

      await ctx.reply(
        "⚠️ Unable to approve this user."
      );
    }
  }
);

// ============================================================
// REJECT VERIFICATION
// ============================================================

bot.action(
  /^reject_verification:(.+)$/,
  async (ctx) => {
    try {
      if (!isAdmin(ctx)) {
        await ctx.answerCbQuery("Not authorized.");
        return;
      }

      await ctx.answerCbQuery("Rejecting user...");

      const userId = ctx.match[1];

      await rejectUser(userId, ctx.from.id);

      await ctx.reply(
        `❌ *VERIFICATION REJECTED*\n\n` +
        `The user's verification request has been rejected.`,
        {
          parse_mode: "Markdown",
        }
      );
    } catch (error) {
      console.error("Reject verification error:", error);

      await ctx.reply(
        "⚠️ Unable to reject this user."
      );
    }
  }
);


/* HOST APPLICATION COMMAND */

bot.command("host", async (ctx) => {
  const args = (ctx.message.text || "")
    .trim()
    .split(/\s+/)
    .slice(1);

  if (args.length !== 1 || args[0].toLowerCase() !== "application") {
    await ctx.reply("Use this command to apply:\n\n/host application");
    return;
  }

  try {
    const result = await startHostApplication(ctx.from);

    if (result.status === "approved") {
      await ctx.reply("✅ Your host application is already approved.");
      return;
    }

    if (result.status === "pending") {
      await ctx.reply("⏳ Your host application is already awaiting admin approval.");
      return;
    }

    await ctx.reply(
      "🎤 SA LIVE HOST APPLICATION\n\n" +
      "Please send the email address you will use for your SA LIVE Firebase website account.\n\n" +
      "Do not send your password here. After submitting your email, create your account through the website signup page.\n\n" +
      "Your host access will remain pending until an administrator approves your application."
    );
  } catch (error) {
    console.error("Start host application error:", error);
    await ctx.reply("Unable to start your application right now. Please try again.");
  }
});

/* COLLECT THE APPLICANT'S EMAIL */

bot.on("text", async (ctx, next) => {
  const text = ctx.message?.text?.trim() || "";

  // Don't intercept commands.
  if (text.startsWith("/")) {
    return next();
  }

  try {
    const result = await submitHostApplicationEmail(
      ctx.from.id,
      text
    );

    if (result.status === "already_host") {
      await ctx.reply("✅ This Firebase account already has host access.");
      return;
    }

    if (result.status === "approved") {
      await ctx.reply("✅ Your host application is already approved.");
      return;
    }

    const signupMessage = result.firebaseAccountExists
      ? "Your Firebase account already exists. Make sure you can sign in to the website using this email."
      : "Please create your Firebase account on the SA LIVE website using this email and choose your password there.";

    await ctx.reply(
      "✅ HOST APPLICATION SUBMITTED\n\n" +
      `Email: ${result.email}\n\n` +
      `${signupMessage}\n\n` +
      "⏳ Your application is pending admin approval. Host access will only be enabled after approval."
    );
  } catch (error) {
    if (error.message === "Please start with /host application first.") {
      return next();
    }

    console.error("Host application email error:", error);
    await ctx.reply(
      "That email could not be submitted. Please enter a valid email address, or start again with /host application."
    );
  }
});

/* ADMIN: REVIEW PENDING HOST APPLICATIONS */

bot.command("host_pending", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("❌ You are not authorized.");
    return;
  }

  try {
    const pending = await getPendingHostApplications();

    if (pending.length === 0) {
      await ctx.reply("✅ There are no pending host applications.");
      return;
    }

    await ctx.reply(`🎤 Pending host applications: ${pending.length}`);

    for (const application of pending) {
      await ctx.reply(
        `HOST APPLICATION\n\n` +
        `Name: ${application.firstName || ""} ${application.lastName || ""}\n` +
        `Email: ${application.email}\n` +
        `Telegram: ${application.telegramUsername ? "@" + application.telegramUsername : "Not set"}\n` +
        `Status: Pending`,
        {
          reply_markup: {
            inline_keyboard: [[
              {
                text: "✅ Approve",
                callback_data: `approve_host:${application.id}`,
              },
              {
                text: "❌ Reject",
                callback_data: `reject_host:${application.id}`,
              },
            ]],
          },
        }
      );
    }
  } catch (error) {
    console.error("Pending host applications error:", error);
    await ctx.reply("Unable to load pending host applications.");
  }
});

/* ADMIN: APPROVE HOST */

bot.action(/^approve_host:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Not authorized.");
    return;
  }

  try {
    await ctx.answerCbQuery("Approving host...");
    const result = await approveHostApplication(ctx.match[1], ctx.from.id);

    await ctx.reply(
      `✅ HOST APPROVED\n\n` +
      `Email: ${result.email}\n\n` +
      "Host access has been assigned. The host must sign out and sign in again to refresh their Firebase token."
    );
  } catch (error) {
    console.error("Approve host error:", error);
    await ctx.reply(
      "⚠️ Approval failed. Confirm that the applicant has created their Firebase account with the submitted email, then try again."
    );
  }
});

/* ADMIN: REJECT HOST */

bot.action(/^reject_host:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Not authorized.");
    return;
  }

  try {
    await ctx.answerCbQuery("Rejecting application...");
    await rejectHostApplication(ctx.match[1], ctx.from.id);
    await ctx.reply("❌ The host application has been rejected.");
  } catch (error) {
    console.error("Reject host error:", error);
    await ctx.reply("Unable to reject this application.");
  }
});

/* APPLICANT: CHECK APPLICATION STATUS */

bot.command("hoststatus", async (ctx) => {
  try {
    const result = await getHostApplicationStatus(ctx.from.id);

    if (result.status === "not_submitted") {
      await ctx.reply("You have not applied yet. Start with /host application");
      return;
    }

    const labels = {
      pending: "⏳ Pending admin approval",
      approved: "✅ Approved",
      rejected: "❌ Rejected",
    };

    await ctx.reply(
      `HOST APPLICATION STATUS\n\n` +
      `Status: ${labels[result.status] || result.status}\n` +
      `Email: ${result.email || "Not provided"}`
    );
  } catch (error) {
    console.error("Host status error:", error);
    await ctx.reply("Unable to check your host application status right now.");
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

    if (
      text === "hi" ||
      text === "hello" ||
      text === "hey" ||
      text === "start" ||
      text === "begin"
    ) {
      return;
    }

    await ctx.reply(
      `🟢 *SA LIVE*\n\n` +
      `I didn't recognise that command.\n\n` +
      `Use the buttons below to continue.`,
      {
        parse_mode: "Markdown",
        ...mainMenu(),
      }
    );
  } catch (error) {
    console.error("Unknown text handler error:", error);
  }
});

// ============================================================
// PAYMENT HANDLERS
// ============================================================

registerPaymentHandlers(bot);

// ============================================================
// TELEGRAM ERROR HANDLER
// ============================================================

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

// ============================================================
// EXPORT BOT
// ============================================================

export {
  bot,
};