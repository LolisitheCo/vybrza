
import { Markup } from "telegraf";
import crypto from "node:crypto";

import {
  getOrCreateUser,
  updateUserPaymentEmail,
  setPendingPaymentPackage,
  clearPendingPayment,
} from "../services/userService.js";

import {
  getPaymentPackage,
  createPaymentRecord,
} from "../services/paymentService.js";

import {
  initializePayfastTransaction,
} from "../services/payfastService.js";

// ============================================================
// EMAIL VALIDATION
// ============================================================

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  );
}

// ============================================================
// PACKAGE MENU
// Package IDs must match paymentService.js exactly.
// ============================================================

function buyMinutesMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "R30 — 5 Minutes",
        "buy_package:starter"
      ),
    ],
    [
      Markup.button.callback(
        "R60 — 10 Minutes",
        "buy_package:ten_minutes"
      ),
    ],
    [
      Markup.button.callback(
        "R180 — 30 Minutes",
        "buy_package:thirty_minutes"
      ),
    ],
    [
      Markup.button.callback(
        "R360 — 60 Minutes",
        "buy_package:sixty_minutes"
      ),
    ],
    [
      Markup.button.callback(
        "R1080 — 3 Hours",
        "buy_package:three_hour"
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Back",
        "back_to_main"
      ),
    ],
  ]);
}

// ============================================================
// REGISTER PAYMENT HANDLERS
// ============================================================

export function registerPaymentHandlers(bot) {
  // ----------------------------------------------------------
  // BUY MINUTES
  // ----------------------------------------------------------

  bot.action("buy_minutes", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      await getOrCreateUser(String(ctx.from.id));

      await ctx.reply(
        "💳 Buy SA LIVE Minutes\n\n" +
        "Choose a package:\n\n" +
        "🟢 R30 — 5 minutes\n" +
        "🟢 R60 — 10 minutes\n" +
        "🟢 R180 — 30 minutes\n" +
        "🟢 R360 — 60 minutes\n" +
        "🟢 R1080 — 3 hours",
        buyMinutesMenu()
      );
    } catch (error) {
      console.error("Buy minutes error:", error);

      await ctx.reply(
        "Unable to open the payment menu. Please try again."
      );
    }
  });

  // ----------------------------------------------------------
  // SELECT PACKAGE
  // ----------------------------------------------------------

  bot.action(/^buy_package:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const packageId = ctx.match[1];
      const paymentPackage = getPaymentPackage(packageId);

      if (!paymentPackage) {
        await ctx.reply(
          "This package is unavailable. Please reopen Buy Minutes."
        );
        return;
      }

      const user = await getOrCreateUser(
        String(ctx.from.id)
      );

      await setPendingPaymentPackage(
        user.id,
        packageId
      );

      if (user.paymentEmail && isValidEmail(user.paymentEmail)) {
        await createCheckout(
          ctx,
          user,
          user.paymentEmail,
          paymentPackage
        );
        return;
      }

      await ctx.reply(
        "📧 EMAIL REQUIRED\n\n" +
        "Enter your email using this command:\n\n" +
        "/email your@gmail.com\n\n" +
        `Selected package: ${paymentPackage.name}\n` +
        `Price: R${paymentPackage.amount}\n` +
        `Minutes: ${paymentPackage.minutes}\n\n` +
        "Your email will be used for your PayFast payment."
      );
    } catch (error) {
      console.error("Package selection error:", error);

      await ctx.reply(
        "Unable to select this package. Please try again."
      );
    }
  });

  // ----------------------------------------------------------
  // EMAIL COMMAND
  // IMPORTANT: Register this command before the general
  // bot.on("text") unknown-message handler in bot.js.
  // ----------------------------------------------------------

  bot.command("email", async (ctx) => {
    try {
      const telegramId = String(ctx.from.id);

      // Handles "/email address@example.com" and commands
      // sent with a Telegram bot username suffix.
      const messageText = ctx.message?.text || "";
      const email = messageText
        .replace(/^\/email(?:@\w+)?\s*/i, "")
        .trim()
        .toLowerCase();

      if (!isValidEmail(email)) {
        await ctx.reply(
          "📧 Please enter a valid email address.\n\n" +
          "Example:\n" +
          "/email your@gmail.com"
        );
        return;
      }

      const user = await getOrCreateUser(telegramId);

      await updateUserPaymentEmail(user.id, email);

      // Reload the user so we use the actual saved fields.
      const updatedUser = await getOrCreateUser(telegramId);

      const pendingPackageId =
        updatedUser.pendingPaymentPackageId ??
        updatedUser.pendingPaymentPackage ??
        null;

      if (!pendingPackageId) {
        await ctx.reply(
          "✅ Your payment email has been saved.\n\n" +
          "Now select Buy Minutes and choose a package."
        );
        return;
      }

      const paymentPackage = getPaymentPackage(
        pendingPackageId
      );

      if (!paymentPackage) {
        await clearPendingPayment(updatedUser.id);

        await ctx.reply(
          "Your email was saved, but that package is no longer available.\n\n" +
          "Please select Buy Minutes and choose a package again."
        );
        return;
      }

      await ctx.reply(
        "✅ Email saved.\nPreparing your secure PayFast checkout..."
      );

      await createCheckout(
        ctx,
        updatedUser,
        email,
        paymentPackage
      );
    } catch (error) {
      console.error("Email command error:", error);

      await ctx.reply(
        "Unable to process your email or create checkout.\n\n" +
        "Please try Buy Minutes again."
      );
    }
  });
}

// ============================================================
// CREATE PAYFAST CHECKOUT
// ============================================================

async function createCheckout(
  ctx,
  user,
  email,
  paymentPackage
) {
  let reference;

  try {
    if (!user?.id || !paymentPackage?.id) {
      throw new Error("User or package information is missing.");
    }

    if (!isValidEmail(email)) {
      throw new Error("Invalid payment email.");
    }

    reference =
      `SALIVE-${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;

    // Create the pending payment record before checkout.
    await createPaymentRecord({
      userId: user.id,
      reference,
      packageId: paymentPackage.id,
      email: email.trim().toLowerCase(),
    });

    // Initialise PayFast using the existing service.
    const checkout = await initializePayfastTransaction({
      email: email.trim().toLowerCase(),
      amount: paymentPackage.amount,
      reference,
      metadata: {
        custom_str1: paymentPackage.id,
      },
    });

    if (
      !checkout?.paymentUrl ||
      !checkout?.fields ||
      typeof checkout.fields !== "object"
    ) {
      throw new Error("PayFast returned incomplete checkout details.");
    }

    // Save/clear the pending selection after checkout is created.
    await clearPendingPayment(user.id);

    // Build a form that POSTs the signed fields to PayFast.
    // The payment URL is the PayFast hosted checkout endpoint.
    const formFields = Object.entries(checkout.fields)
      .map(([key, value]) => {
        const safeKey = escapeHtml(key);
        const safeValue = escapeHtml(value);

        return (
          `<input type="hidden" name="${safeKey}" ` +
          `value="${safeValue}">`
        );
      })
      .join("\n");

    const html =
      "<!doctype html>" +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>SA LIVE PayFast Checkout</title></head>" +
      '<body style="background:#020617;color:#fff;font-family:Arial,sans-serif;' +
      "display:grid;place-items:center;min-height:100vh;margin:0;padding:24px\">" +
      '<main style="max-width:420px;text-align:center;background:#0f172a;' +
      'padding:28px;border-radius:16px">' +
      '<h2 style="color:#4ade80">SA LIVE Payment</h2>' +
      `<p>Package: ${escapeHtml(paymentPackage.name)}</p>` +
      `<p>Amount: R${escapeHtml(paymentPackage.amount)}</p>` +
      `<p>Minutes: ${escapeHtml(paymentPackage.minutes)}</p>` +
      `<form id="payfast-form" method="POST" action="${escapeHtml(checkout.paymentUrl)}">` +
      formFields +
      '<button type="submit" style="padding:14px 22px;background:#4ade80;' +
      'border:0;border-radius:8px;font-weight:bold;cursor:pointer">' +
      "Continue to PayFast</button></form>" +
      "<p>If the redirect does not happen, use the button.</p>" +
      '<script>document.getElementById("payfast-form").submit();</script>' +
      "</main></body></html>";

    // Send the HTML page as a Telegram attachment is not suitable.
    // The bot needs a publicly hosted checkout page to serve this HTML.
    // Therefore, don't claim the checkout is usable until you host it.
    //
    // This bot-only file cannot expose a local HTML page to the user.
    // Your backend should provide a route that serves this form.

    await ctx.reply(
      "💳 PAYFAST CHECKOUT CREATED\n\n" +
      `Package: ${paymentPackage.name}\n` +
      `Amount: R${paymentPackage.amount}\n` +
      `Minutes: ${paymentPackage.minutes}\n\n` +
      "Your payment record has been created, but the secure PayFast form needs to be served by your backend before payment can continue.\n\n" +
      `Payment reference: ${reference}`
    );

    console.log(
      "PayFast checkout prepared:",
      reference,
      "HTML length:",
      html.length
    );
  } catch (error) {
    console.error("Create PayFast checkout error:", error);

    await ctx.reply(
      "❌ We couldn't create your PayFast checkout.\n\n" +
      "Please try again shortly. If this keeps happening, check the backend logs."
    );
  }
}

// ============================================================
// HTML ESCAPING
// ============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
