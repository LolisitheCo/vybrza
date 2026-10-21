import crypto from "node:crypto";
import { Markup } from "telegraf";

import {
  getPaymentPackage,
  createPaymentRecord,
} from "../services/paymentService.js";

import {
  getOrCreateUser,
  updateUserPaymentEmail,
} from "../services/userService.js";

// ============================================================
// SA LIVE PAYMENT BOT — PAYFAST
// ============================================================

const PAYMENT_PACKAGES = [
  "starter",
  "ten_minutes",
  "thirty_minutes",
  "sixty_minutes",
  "three_hour",
];

const PAYMENT_REFERENCE_PATTERN = /^SALIVE-[A-F0-9]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pending email requests are keyed by Telegram ID.
// They remain in memory only while this server process runs.
const pendingEmailRequests = new Map();

// ============================================================
// HELPERS
// ============================================================

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();

  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }

  return email;
}

function createPaymentReference() {
  return `SALIVE-${crypto.randomUUID()
    .replace(/-/g, "")
    .toUpperCase()}`;
}

function getPublicFrontendUrl() {
  const value = process.env.FRONTEND_URL?.trim();

  if (!value) {
    throw new Error("FRONTEND_URL is not configured.");
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("FRONTEND_URL is invalid.");
  }

  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost"
  ) {
    throw new Error(
      "FRONTEND_URL must use HTTPS in production."
    );
  }

  return url.origin;
}

function createCheckoutBridgeUrl(frontendUrl, reference) {
  if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
    throw new Error("Invalid SA LIVE payment reference.");
  }

  const url = new URL("/payfast-checkout", frontendUrl);
  url.searchParams.set("reference", reference);

  return url.toString();
}

function getPackageKeyboard() {
  const labels = {
    starter: "⏱️ 5 Minutes — R30",
    ten_minutes: "⏱️ 10 Minutes — R60",
    thirty_minutes: "⏱️ 30 Minutes — R180",
    sixty_minutes: "⏱️ 60 Minutes — R360",
    three_hour: "⏱️ 3 Hours — R1,080",
  };

  return Markup.inlineKeyboard([
    ...PAYMENT_PACKAGES.map((packageId) => [
      Markup.button.callback(
        labels[packageId],
        `buy_minutes:${packageId}`
      ),
    ]),
    [
      Markup.button.callback(
        "🔄 Refresh Balance",
        "payment_balance"
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Main Menu",
        "payment_main_menu"
      ),
    ],
  ]);
}

function formatPackage(paymentPackage) {
  const amount = Number(paymentPackage.amount);
  const minutes = Number(paymentPackage.minutes);

  if (
    typeof paymentPackage.name !== "string" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(minutes) ||
    minutes <= 0
  ) {
    throw new Error("Payment package details are invalid.");
  }

  return (
    `💳 *SA LIVE — BUY MINUTES*\n\n` +
    `📦 Package: *${paymentPackage.name}*\n` +
    `💵 Price: *R${amount.toFixed(2)}*\n` +
    `⏱️ Minutes: *${minutes}*\n\n` +
    `🔐 Payments are processed through PayFast.\n\n` +
    `Your minutes are credited only after the backend verifies payment.\n\n` +
    `_SA LIVE — More than just a call._`
  );
}

function clearPendingEmail(telegramId) {
  pendingEmailRequests.delete(String(telegramId));
}

// ============================================================
// PREPARE PAYMENT
// ============================================================

async function preparePayment({
  ctx,
  user,
  paymentPackage,
  email,
}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("A valid payment email is required.");
  }

  if (!user?.id) {
    throw new Error("Could not identify the SA LIVE account.");
  }

  if (!PAYMENT_PACKAGES.includes(paymentPackage.id)) {
    throw new Error("Invalid payment package.");
  }

  const frontendUrl = getPublicFrontendUrl();
  const reference = createPaymentReference();

  if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
    throw new Error("Could not generate a valid payment reference.");
  }

  console.log("Preparing SA LIVE PayFast payment:", {
    userId: String(user.id),
    packageId: paymentPackage.id,
    hasEmail: true,
    hasReference: true,
    referenceType: typeof reference,
    referenceLength: reference.length,
  });

  // Save a pending payment. Do not credit minutes here.
  await createPaymentRecord({
    userId: String(user.id),
    reference,
    packageId: paymentPackage.id,
    email: normalizedEmail,
  });

  const checkoutUrl = createCheckoutBridgeUrl(
    frontendUrl,
    reference
  );

  await ctx.reply(
    formatPackage(paymentPackage) +
      `\n\n🧾 Reference: \`${reference}\`\n\n` +
      "Select below to continue to secure checkout.",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(
            "🔐 Continue to secure checkout",
            checkoutUrl
          ),
        ],
        [
          Markup.button.callback(
            "💳 Other Packages",
            "buy_minutes"
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Main Menu",
            "payment_main_menu"
          ),
        ],
      ]),
    }
  );
}

// ============================================================
// REGISTER PAYMENT HANDLERS
// ============================================================

export function registerPaymentHandlers(bot) {
  if (!bot || typeof bot.action !== "function") {
    throw new Error(
      "A valid Telegraf bot instance is required."
    );
  }

  // ----------------------------------------------------------
  // OPEN BUY MINUTES MENU
  // ----------------------------------------------------------

  bot.action("buy_minutes", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      await ctx.reply(
        "💳 *SA LIVE — BUY MINUTES*\n\n" +
          "Choose a package below.\n\n" +
          "💵 R6 per minute\n" +
          "🔐 Payments powered by PayFast",
        {
          parse_mode: "Markdown",
          ...getPackageKeyboard(),
        }
      );
    } catch (error) {
      console.error("Open payment menu failed:", error);
    }
  });

  // ----------------------------------------------------------
  // SELECT PACKAGE
  // ----------------------------------------------------------

  bot.action(
    /^buy_minutes:(starter|ten_minutes|thirty_minutes|sixty_minutes|three_hour)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery(
          "Preparing your secure payment..."
        );

        if (!ctx.from?.id) {
          throw new Error("A valid Telegram user is required.");
        }

        const user = await getOrCreateUser(ctx.from);

        if (!user?.id) {
          throw new Error("Could not identify your SA LIVE account.");
        }

        if (user.verificationStatus !== "approved") {
          await ctx.reply(
            "🛡️ *VERIFICATION REQUIRED*\n\n" +
              "Your account must be approved before you can purchase minutes.",
            { parse_mode: "Markdown" }
          );

          return;
        }

        const packageId = ctx.match[1];

        if (!PAYMENT_PACKAGES.includes(packageId)) {
          await ctx.reply("That payment package is unavailable.");
          return;
        }

        const paymentPackage = getPaymentPackage(packageId);

        if (!paymentPackage) {
          throw new Error("Payment package was not found.");
        }

        const amount = Number(paymentPackage.amount);
        const minutes = Number(paymentPackage.minutes);

        if (
          !Number.isFinite(amount) ||
          amount <= 0 ||
          !Number.isSafeInteger(minutes) ||
          minutes <= 0
        ) {
          throw new Error("Invalid payment package pricing.");
        }

        // Read the field used by userService.js.
        const savedEmail = normalizeEmail(user.paymentEmail);

        if (!savedEmail) {
          // Preserve the package while waiting for the email.
          pendingEmailRequests.set(String(ctx.from.id), {
            userId: String(user.id),
            packageId,
          });

          await ctx.reply(
            "📧 *EMAIL REQUIRED*\n\n" +
              "Your account uses your Telegram account, so you do not need to register with a separate username or password.\n\n" +
              "PayFast requires an email address for checkout.\n\n" +
              "Please send your email address in this chat.\n\n" +
              "Example: you@example.com\n\n" +
              "_Your email will be saved to your SA LIVE account._",
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "❌ Cancel",
                    "cancel_payment_email"
                  ),
                ],
              ]),
            }
          );

          return;
        }

        await preparePayment({
          ctx,
          user,
          paymentPackage,
          email: savedEmail,
        });
      } catch (error) {
        console.error("Initialize payment failed:", error);

        await ctx.reply(
          "❌ *PAYMENT SETUP FAILED*\n\n" +
            "We couldn't prepare your payment. No minutes were added.\n\n" +
            "Please try again later. If you were charged, contact SA LIVE support before retrying.",
          { parse_mode: "Markdown" }
        );
      }
    }
  );

  // ----------------------------------------------------------
  // RECEIVE PAYMENT EMAIL
  // ----------------------------------------------------------
  // IMPORTANT:
  // This handler calls next() when no payment email is pending.
  // The existing host application email handler can then process
  // the message if it belongs to a host application.
  // ----------------------------------------------------------

  bot.on("text", async (ctx, next) => {
    const telegramId = String(ctx.from?.id ?? "");
    const request = pendingEmailRequests.get(telegramId);

    if (!request) {
      return next();
    }

    const messageText = ctx.message?.text?.trim() || "";

    // Allow commands to reach their own handlers.
    if (messageText.startsWith("/")) {
      return next();
    }

    // Do not interpret another bot menu interaction as an email.
    const email = normalizeEmail(messageText);

    if (!email) {
      await ctx.reply(
        "❌ That email address doesn't look valid.\n\n" +
          "Please send an address such as you@example.com.\n\n" +
          "Or use Cancel to stop the payment process."
      );

      return;
    }

    try {
      const user = await getOrCreateUser(ctx.from);

      if (String(user.id) !== request.userId) {
        clearPendingEmail(telegramId);

        await ctx.reply(
          "Your account could not be verified. Please start the payment process again."
        );

        return;
      }

      if (user.verificationStatus !== "approved") {
        clearPendingEmail(telegramId);

        await ctx.reply(
          "Your account must be approved before you can purchase minutes."
        );

        return;
      }

      const paymentPackage = getPaymentPackage(request.packageId);

      if (!paymentPackage) {
        throw new Error("Payment package was not found.");
      }

      // Save the email to the paymentEmail Firestore field.
      await updateUserPaymentEmail(user.id, email);

      // Clear only after the email has been saved successfully.
      clearPendingEmail(telegramId);

      await ctx.reply(
        "✅ Email saved successfully.\n\n" +
          "Preparing your PayFast checkout..."
      );

      await preparePayment({
        ctx,
        user: {
          ...user,
          paymentEmail: email,
        },
        paymentPackage,
        email,
      });
    } catch (error) {
      console.error(
        "Save payment email or prepare checkout failed:",
        error
      );

      await ctx.reply(
        "We couldn't complete the payment setup.\n\n" +
          "Your email may already have been saved. Please try Buy Minutes again."
      );
    }
  });

  // ----------------------------------------------------------
  // CANCEL EMAIL REQUEST
  // ----------------------------------------------------------

  bot.action("cancel_payment_email", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (ctx.from?.id) {
        clearPendingEmail(ctx.from.id);
      }

      await ctx.reply(
        "Email entry cancelled. No payment was started.",
        {
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "💳 Buy Minutes",
                "buy_minutes"
              ),
            ],
            [
              Markup.button.callback(
                "⬅️ Main Menu",
                "payment_main_menu"
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error("Cancel email request failed:", error);
    }
  });

  // ----------------------------------------------------------
  // REFRESH BALANCE
  // ----------------------------------------------------------

  bot.action("payment_balance", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!ctx.from?.id) {
        throw new Error("A valid Telegram user is required.");
      }

      const user = await getOrCreateUser(ctx.from);
      const minutes = Number(user.minutes ?? 0);

      if (!Number.isSafeInteger(minutes) || minutes < 0) {
        throw new Error("Stored minute balance is invalid.");
      }

      await ctx.reply(
        "💰 *SA LIVE BALANCE*\n\n" +
          `⏱️ Available minutes: *${minutes}*\n\n` +
          "Purchase a package when you need more time.",
        {
          parse_mode: "Markdown",
          ...getPackageKeyboard(),
        }
      );
    } catch (error) {
      console.error("Payment balance failed:", error);

      await ctx.reply(
        "Unable to retrieve your balance right now."
      );
    }
  });

  // ----------------------------------------------------------
  // RETURN TO MAIN MENU
  // ----------------------------------------------------------

  bot.action("payment_main_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      await ctx.reply(
        "🟢 *SA LIVE*\n\n" +
          "*MEET • TALK • CONNECT*\n\n" +
          "Choose an option below to continue.",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "💳 Buy Minutes",
                "buy_minutes"
              ),
            ],
            [
              Markup.button.callback(
                "💰 My Balance",
                "payment_balance"
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error("Return to payment menu failed:", error);
    }
  });
}