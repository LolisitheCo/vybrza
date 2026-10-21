
import {
  Markup,
} from "telegraf";

import {
  getPaymentPackage,
} from "../services/paymentService.js";

import {
  initializePayfastTransaction,
} from "../services/payfastService.js";

import {
  getOrCreateUser,
} from "../services/userService.js";

// ============================================================
// SA LIVE PAYMENT BOT
// PayFast integration
// ============================================================

const PAYMENT_PACKAGES = [
  "starter",
  "ten_minutes",
  "thirty_minutes",
  "sixty_minutes",
  "three_hour",
];

const MAX_URL_LENGTH = 2048;

// ============================================================
// HELPERS
// ============================================================

function getPublicFrontendUrl() {
  const value = process.env.FRONTEND_URL;

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

function getSafePaymentUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_URL_LENGTH
  ) {
    throw new Error("Payment URL is invalid.");
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Payment URL is invalid.");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Payment provider URL is not secure."
    );
  }

  const allowedHosts = new Set([
    "www.payfast.co.za",
    "sandbox.payfast.co.za",
  ]);

  if (!allowedHosts.has(url.hostname)) {
    throw new Error(
      "Payment URL is not an approved PayFast destination."
    );
  }

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
  return (
    `💳 *SA LIVE — BUY MINUTES*\n\n` +
    `📦 Package: *${paymentPackage.name}*\n` +
    `💵 Price: *R${paymentPackage.amount.toFixed(2)}*\n` +
    `⏱️ Minutes: *${paymentPackage.minutes}*\n\n` +
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
  // SELECT PACKAGE AND INITIALIZE PAYMENT
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

        const telegramId = String(ctx.from.id);

        const user = await getOrCreateUser(
          telegramId
        );

        if (
          !user ||
          typeof user.id !== "string" ||
          user.id !== telegramId
        ) {
          throw new Error(
            "Unable to identify your SA LIVE account."
          );
        }

        if (
          user.verificationStatus !== "approved"
        ) {
          await ctx.reply(
            "🛡️ *VERIFICATION REQUIRED*\n\n" +
            "Your account must be approved before you can purchase and use SA LIVE minutes.",
            {
              parse_mode: "Markdown",
            }
          );

          return;
        }

        const packageId = ctx.match[1];

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

        const frontendUrl =
          getPublicFrontendUrl();

        /*
         * IMPORTANT:
         * This function must create a pending payment
         * server-side before redirecting the customer.
         *
         * Do not trust the browser return URL to credit
         * minutes. Only verified PayFast ITNs may do that.
         */

        const transaction =
          await initializePayfastTransaction({
            userId: user.id,
            packageId: paymentPackage.id,
            email: user.email || undefined,
          });

        if (
          !transaction ||
          typeof transaction !== "object"
        ) {
          throw new Error(
            "PayFast did not return a valid transaction."
          );
        }

        /*
         * Supports the common result names used by payment
         * services. Confirm the actual return shape of your
         * payfastService.js before deploying.
         */

        const rawPaymentUrl =
          transaction.paymentUrl ||
          transaction.redirectUrl ||
          transaction.checkoutUrl ||
          transaction.url;

        const paymentUrl =
          getSafePaymentUrl(rawPaymentUrl);

        const reference =
          transaction.reference ||
          transaction.paymentReference ||
          transaction.m_payment_id;

        if (
          typeof reference !== "string" ||
          reference.trim().length === 0
        ) {
          throw new Error(
            "Payment reference is missing."
          );
        }

        const message =
          formatPackage(paymentPackage) +
          `\n\n🧾 Reference: \`${reference}\`\n\n` +
          `Select the button below to continue to PayFast.`;

        await ctx.reply(
          message,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.url(
                  "🔐 Pay securely with PayFast",
                  paymentUrl
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
      } catch (error) {
        console.error(
          "Initialize payment failed:",
          error.message
        );

        if (!callbackAnswered) {
          try {
            await ctx.answerCbQuery(
              "Unable to prepare payment."
            );
          } catch {
            // Telegram callback may have expired.
          }
        }

        await ctx.reply(
          "❌ *PAYMENT SETUP FAILED*\n\n" +
          "We couldn't prepare your payment. No minutes have been added.\n\n" +
          "Please try again later. If money was deducted, contact SA LIVE support before retrying.",
          {
            parse_mode: "Markdown",
          }
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

      const user = await getOrCreateUser(
        String(ctx.from.id)
      );

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
          reply_markup: {
            inline_keyboard: [
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
            ],
          },
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
