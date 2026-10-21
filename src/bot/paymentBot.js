
import crypto from "node:crypto";
import { Markup } from "telegraf";

import {
  getPaymentPackage,
  createPaymentRecord,
} from "../services/paymentService.js";

import {
  getOrCreateUser,
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

// ============================================================
// HELPERS
// ============================================================

function getPublicFrontendUrl() {
  const value = process.env.FRONTEND_URL;

  if (typeof value !== "string" || !value.trim()) {
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

function createPaymentReference() {
  return `SALIVE-${crypto.randomUUID()
    .replace(/-/g, "")
    .toUpperCase()}`;
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
    `🔐 Payments are processed securely through PayFast.\n\n` +
    `Your minutes are credited only after the backend verifies the payment.\n\n` +
    `_SA LIVE — More than just a call._`
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
  // OPEN PACKAGE MENU
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
      console.error(
        "Open payment menu failed:",
        error.message
      );

      await ctx.reply(
        "Unable to open the payment menu right now. Please try again."
      );
    }
  });

  // ----------------------------------------------------------
  // SELECT PACKAGE AND CREATE PENDING PAYMENT
  // ----------------------------------------------------------

  bot.action(
    /^buy_minutes:(starter|ten_minutes|thirty_minutes|sixty_minutes|three_hour)$/,
    async (ctx) => {
      let callbackAnswered = false;

      try {
        await ctx.answerCbQuery(
          "Preparing your secure payment..."
        );

        callbackAnswered = true;

        if (!ctx.from?.id) {
          throw new Error(
            "A valid Telegram user is required."
          );
        }

        const user = await getOrCreateUser(ctx.from);

        if (!user || user.id == null) {
          throw new Error(
            "Could not identify your SA LIVE account."
          );
        }

        if (user.verificationStatus !== "approved") {
          await ctx.reply(
            "🛡️ *VERIFICATION REQUIRED*\n\n" +
              "Your account must be approved before you can purchase and use SA LIVE minutes.",
            { parse_mode: "Markdown" }
          );

          return;
        }

        const packageId = ctx.match?.[1];

        if (!PAYMENT_PACKAGES.includes(packageId)) {
          await ctx.reply(
            "That payment package is unavailable. Please select another."
          );

          return;
        }

        const paymentPackage =
          getPaymentPackage(packageId);

        if (!paymentPackage) {
          throw new Error(
            "Selected payment package was not found."
          );
        }

        const amount = Number(paymentPackage.amount);
        const minutes = Number(paymentPackage.minutes);

        if (
          !Number.isFinite(amount) ||
          amount <= 0 ||
          !Number.isSafeInteger(minutes) ||
          minutes <= 0
        ) {
          throw new Error(
            "The selected payment package has invalid pricing."
          );
        }

        const email =
          typeof user.email === "string"
            ? user.email.trim().toLowerCase()
            : "";

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
          await ctx.reply(
            "📧 *EMAIL REQUIRED*\n\n" +
              "A valid email address is needed to prepare your PayFast payment. Please update your SA LIVE account email and try again.",
            { parse_mode: "Markdown" }
          );

          return;
        }

        const frontendUrl = getPublicFrontendUrl();
        const reference = createPaymentReference();

        if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
          throw new Error(
            "Could not generate a valid payment reference."
          );
        }

        // Save the payment as pending before checkout.
        // This function must NOT credit the user's minutes.
        await createPaymentRecord({
          userId: String(user.id),
          reference,
          packageId: paymentPackage.id,
          email,
        });

        // The checkout bridge must look up this reference
        // server-side, load the pending payment, generate
        // PayFast fields, and submit them using an HTTP POST.
        const checkoutUrl = createCheckoutBridgeUrl(
          frontendUrl,
          reference
        );

        const message =
          formatPackage(paymentPackage) +
          `\n\n🧾 Reference: \`${reference}\`\n\n` +
          "Select the button below to continue to secure checkout.";

        await ctx.reply(message, {
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
        });
      } catch (error) {
        console.error(
          "Initialize payment failed:",
          error
        );

        if (!callbackAnswered) {
          try {
            await ctx.answerCbQuery(
              "Unable to prepare payment."
            );
          } catch {
            // The Telegram callback may have expired.
          }
        }

        await ctx.reply(
          "❌ *PAYMENT SETUP FAILED*\n\n" +
            "We couldn't prepare your payment. No minutes have been added.\n\n" +
            "Please try again later. If you were charged, contact SA LIVE support before retrying.",
          { parse_mode: "Markdown" }
        );
      }
    }
  );

  // ----------------------------------------------------------
  // REFRESH BALANCE
  // ----------------------------------------------------------

  bot.action("payment_balance", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!ctx.from?.id) {
        throw new Error(
          "A valid Telegram user is required."
        );
      }

      const user = await getOrCreateUser(ctx.from);
      const minutes = Number(user.minutes ?? 0);

      if (
        !Number.isSafeInteger(minutes) ||
        minutes < 0
      ) {
        throw new Error(
          "Stored minute balance is invalid."
        );
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
      console.error(
        "Payment balance failed:",
        error.message
      );

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
      console.error(
        "Return to payment menu failed:",
        error.message
      );
    }
  });
}
