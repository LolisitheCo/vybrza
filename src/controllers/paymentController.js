import crypto from "node:crypto";

import {
  getPaymentPackage,
  createPaymentRecord,
  getPaymentByReference,
  attachStitchPaymentLink,
  creditSuccessfulPayment,
} from "../services/paymentService.js";

import {
  createStitchPaymentLink,
  getStitchPaymentLink,
  getStitchPayment,
} from "../services/stitchService.js";

const PAYMENT_REFERENCE_PATTERN = /^SALIVE-[A-F0-9]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBHOOK_TOLERANCE_SECONDS = 300;

// ============================================================
// HELPERS
// ============================================================

function getAuthenticatedUserId(req) {
  const uid = req.user?.uid;

  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.length > 128
  ) {
    return null;
  }

  return uid.trim();
}

function isPaymentOwner(payment, userId) {
  return Boolean(
    payment &&
    userId &&
    String(payment.userId) === userId
  );
}

function isValidReference(reference) {
  return (
    typeof reference === "string" &&
    PAYMENT_REFERENCE_PATTERN.test(reference)
  );
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    email === email.trim() &&
    EMAIL_PATTERN.test(email)
  );
}

function getPayerName(req) {
  const possibleNames = [
    req.user?.displayName,
    req.user?.name,
    req.body?.payerName,
  ];

  for (const value of possibleNames) {
    if (typeof value === "string") {
      const name = value.trim().replace(/\s+/g, " ");

      if (name.length >= 3 && name.length <= 40) {
        return name;
      }
    }
  }

  return "SA LIVE Customer";
}

function validateStoredPayment(payment, reference) {
  if (
    !payment ||
    payment.reference !== reference ||
    payment.provider !== "stitch" ||
    payment.currency !== "ZAR" ||
    payment.status !== "pending" ||
    payment.credited === true
  ) {
    return false;
  }

  const paymentPackage = getPaymentPackage(payment.packageId);

  if (!paymentPackage) {
    return false;
  }

  return (
    payment.amount === paymentPackage.amount &&
    payment.minutes === paymentPackage.minutes &&
    payment.amountCents === paymentPackage.amount * 100
  );
}

// ============================================================
// STITCH REDIRECT URL
// ============================================================

function addRedirectUrl(paymentLink, reference) {
  if (
    !paymentLink ||
    typeof paymentLink.link !== "string"
  ) {
    throw new Error("Stitch did not return a checkout link.");
  }

  const configuredRedirect =
    process.env.STITCH_REDIRECT_URL?.trim();

  if (!configuredRedirect) {
    return paymentLink.link;
  }

  const returnUrl = new URL(configuredRedirect);

  if (returnUrl.protocol !== "https:") {
    throw new Error(
      "STITCH_REDIRECT_URL must use HTTPS."
    );
  }

  returnUrl.searchParams.set("reference", reference);

  const checkoutUrl = new URL(paymentLink.link);

  if (
    checkoutUrl.protocol !== "https:" ||
    checkoutUrl.hostname !== "express.stitch.money"
  ) {
    throw new Error("Invalid Stitch Express checkout URL.");
  }

  checkoutUrl.searchParams.set(
    "redirect_url",
    returnUrl.toString()
  );

  return checkoutUrl.toString();
}

// ============================================================
// CREATE OR REUSE STITCH CHECKOUT
// ============================================================


async function createCheckoutForPayment(payment, req = {}) {
  // ==========================================================
  // REUSE AN EXISTING STITCH PAYMENT LINK
  // ==========================================================

  if (
    typeof payment.stitchPaymentLinkId === "string" &&
    payment.stitchPaymentLinkId.trim()
  ) {
    const existingLink = await getStitchPaymentLink(
      payment.stitchPaymentLinkId
    );

    if (
      existingLink.id !== payment.stitchPaymentLinkId ||
      existingLink.merchantReference !== payment.reference ||
      existingLink.amount !== payment.amountCents
    ) {
      throw new Error(
        "The existing Stitch payment link does not match this payment."
      );
    }

    if (
      String(existingLink.status || "").toUpperCase() !== "PENDING"
    ) {
      throw new Error(
        "The existing Stitch payment link is no longer pending."
      );
    }

    const redirectUrl = addRedirectUrl(
      existingLink,
      payment.reference
    );

    console.log("STITCH EXISTING PAYMENT LINK DIAGNOSTIC:", {
      paymentLinkId: existingLink.id,
      returnedLink: existingLink.link,
      finalCheckoutUrl: redirectUrl,
      amount: existingLink.amount,
      merchantReference: existingLink.merchantReference,
      status: existingLink.status,
    });

    return {
      paymentLinkId: existingLink.id,
      redirectUrl,
    };
  }

  // ==========================================================
  // CREATE A NEW STITCH PAYMENT LINK
  // ==========================================================

  const paymentLink = await createStitchPaymentLink({
    amount: payment.amountCents,
    payerName: getPayerName(req),
    payerEmailAddress: payment.email,
    merchantReference: payment.reference,
  });

  // ==========================================================
  // VALIDATE STITCH RESPONSE
  // ==========================================================

  if (
    !paymentLink ||
    typeof paymentLink.id !== "string" ||
    typeof paymentLink.link !== "string" ||
    !paymentLink.link.trim() ||
    paymentLink.amount !== payment.amountCents ||
    paymentLink.merchantReference !== payment.reference
  ) {
    throw new Error(
      "Stitch returned a payment link that did not match the SA LIVE payment."
    );
  }

  // ==========================================================
  // PREPARE CHECKOUT URL
  // ==========================================================

  const redirectUrl = addRedirectUrl(
    paymentLink,
    payment.reference
  );

  // ==========================================================
  // DIAGNOSTIC LOGGING
  // ==========================================================

  console.log("STITCH NEW PAYMENT LINK DIAGNOSTIC:", {
    paymentLinkId: paymentLink.id,
    returnedLink: paymentLink.link,
    finalCheckoutUrl: redirectUrl,
    amount: paymentLink.amount,
    merchantReference: paymentLink.merchantReference,
    status: paymentLink.status || "NOT_RETURNED",
  });

  // ==========================================================
  // SAVE STITCH PAYMENT LINK TO FIRESTORE
  // ==========================================================

  await attachStitchPaymentLink({
    reference: payment.reference,
    paymentLinkId: paymentLink.id,
    redirectUrl,
  });

  // ==========================================================
  // RETURN CHECKOUT DETAILS
  // ==========================================================

  return {
    paymentLinkId: paymentLink.id,
    redirectUrl,
  };
}


// ============================================================
// VERIFY A PAYMENT DIRECTLY WITH STITCH
// ============================================================

async function verifyAndCreditPayment(payment, eventId = null) {
  if (
    !payment ||
    typeof payment.stitchPaymentLinkId !== "string"
  ) {
    throw new Error("Stitch payment link ID is missing.");
  }

  const paymentLink = await getStitchPaymentLink(
    payment.stitchPaymentLinkId
  );

  if (
    paymentLink.id !== payment.stitchPaymentLinkId ||
    paymentLink.merchantReference !== payment.reference ||
    paymentLink.amount !== payment.amountCents
  ) {
    throw new Error(
      "Stitch payment link does not match the SA LIVE payment."
    );
  }

  const linkStatus = String(
    paymentLink.status || ""
  ).toUpperCase();

  if (linkStatus !== "PAID") {
    return {
      success: true,
      credited: false,
      status: linkStatus || "PENDING",
    };
  }

  const paymentId = paymentLink.paymentId;

  if (
    typeof paymentId !== "string" ||
    !paymentId.trim()
  ) {
    throw new Error(
      "Stitch marked the link as paid but did not return a payment ID."
    );
  }

  const stitchPayment = await getStitchPayment(paymentId);

  const paymentStatus = String(
    stitchPayment.status || ""
  ).toUpperCase();

  if (
    paymentStatus !== "PAID" &&
    paymentStatus !== "SETTLED"
  ) {
    return {
      success: true,
      credited: false,
      status: paymentStatus || "PENDING",
    };
  }

  if (
    stitchPayment.id !== paymentId ||
    stitchPayment.type !== "LINK" ||
    stitchPayment.amount !== payment.amountCents ||
    (
      stitchPayment.merchantReference &&
      stitchPayment.merchantReference !== payment.reference
    )
  ) {
    throw new Error(
      "Stitch payment details do not match the SA LIVE payment."
    );
  }

  const result = await creditSuccessfulPayment(
    payment.reference,
    {
      paymentId,
      paymentLinkId: paymentLink.id,
      eventId,
    }
  );

  return {
    success: true,
    credited: true,
    alreadyCredited: result.alreadyCredited === true,
    minutes: result.minutes,
    status: paymentStatus,
  };
}

// ============================================================
// INITIALIZE A NEW PAYMENT
// POST /api/payments/initialize
// ============================================================

export async function initializePayment(req, res) {
  try {
    const authenticatedUserId = getAuthenticatedUserId(req);

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const { userId, packageId, email } = req.body ?? {};

    if (
      userId !== undefined &&
      String(userId) !== authenticatedUserId
    ) {
      return res.status(403).json({
        success: false,
        message: "User identity mismatch.",
      });
    }

    if (
      typeof packageId !== "string" ||
      packageId.length > 64 ||
      !/^[a-zA-Z0-9_-]+$/.test(packageId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment package.",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    const paymentPackage = getPaymentPackage(packageId);

    if (
      !paymentPackage ||
      !Number.isFinite(Number(paymentPackage.amount)) ||
      paymentPackage.amount <= 0 ||
      !Number.isSafeInteger(paymentPackage.minutes) ||
      paymentPackage.minutes <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment package.",
      });
    }

    const reference = `SALIVE-${crypto.randomUUID()
      .replace(/-/g, "")
      .toUpperCase()}`;

    await createPaymentRecord({
      userId: authenticatedUserId,
      reference,
      packageId: paymentPackage.id,
      email: email.toLowerCase(),
    });

    const payment = await getPaymentByReference(reference);

    if (
      !payment ||
      payment.provider !== "stitch" ||
      payment.amountCents !== paymentPackage.amount * 100
    ) {
      throw new Error(
        "SA LIVE payment record was not created correctly."
      );
    }

    const checkout = await createCheckoutForPayment(
      payment,
      req
    );

    return res.status(200).json({
      success: true,
      message: "Stitch checkout created.",
      payment: {
        reference,
        packageId: paymentPackage.id,
        packageName: paymentPackage.name,
        amount: paymentPackage.amount,
        amountCents: payment.amountCents,
        currency: "ZAR",
        minutes: paymentPackage.minutes,
        paymentLinkId: checkout.paymentLinkId,
        redirectUrl: checkout.redirectUrl,
        provider: "stitch",
      },
    });
  } catch (error) {
    console.error(
      "Initialize Stitch Express payment failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to initialize checkout. Please try again.",
    });
  }
}

// ============================================================
// REUSE AN EXISTING PAYMENT CHECKOUT
// POST /api/payments/checkout/:reference
// ============================================================

export async function initializeExistingPaymentCheckout(
  req,
  res
) {
  try {
    const reference = req.params?.reference;
    const authenticatedUserId = getAuthenticatedUserId(req);

    if (!isValidReference(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference.",
      });
    }

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const payment = await getPaymentByReference(reference);

    if (!isPaymentOwner(payment, authenticatedUserId)) {
      return res.status(404).json({
        success: false,
        message: "Payment not found.",
      });
    }

    if (!validateStoredPayment(payment, reference)) {
      return res.status(409).json({
        success: false,
        message:
          "This payment is no longer available for checkout.",
      });
    }

    if (!isValidEmail(payment.email)) {
      return res.status(409).json({
        success: false,
        message:
          "A valid payment email is missing. Please update your email.",
      });
    }

    const checkout = await createCheckoutForPayment(
      payment,
      req
    );

    return res.status(200).json({
      success: true,
      provider: "stitch",
      reference,
      paymentLinkId: checkout.paymentLinkId,
      redirectUrl: checkout.redirectUrl,
    });
  } catch (error) {
    console.error(
      "Existing Stitch checkout failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to prepare checkout. Please try again shortly.",
    });
  }
}

// ============================================================
// CHECK PAYMENT STATUS
// GET /api/payments/verify/:reference
// ============================================================

export async function verifyPayment(req, res) {
  try {
    const authenticatedUserId = getAuthenticatedUserId(req);
    const reference = req.params?.reference;

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    if (!isValidReference(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference.",
      });
    }

    const payment = await getPaymentByReference(reference);

    if (!isPaymentOwner(payment, authenticatedUserId)) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found.",
      });
    }

    if (
      payment.status === "complete" &&
      payment.credited === true
    ) {
      return res.status(200).json({
        success: true,
        payment: {
          reference,
          provider: "stitch",
          status: "complete",
          credited: true,
          minutes: payment.minutes,
          amount: payment.amount,
          currency: payment.currency,
        },
      });
    }

    let stitchStatus = null;

    if (payment.stitchPaymentLinkId) {
      const result = await verifyAndCreditPayment(payment);
      stitchStatus = result.status || null;
    }

    const updatedPayment = await getPaymentByReference(reference);

    return res.status(200).json({
      success: true,
      payment: {
        reference: updatedPayment.reference,
        provider: updatedPayment.provider,
        status: updatedPayment.status,
        credited: updatedPayment.credited === true,
        minutes: updatedPayment.minutes,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        stitchStatus,
      },
    });
  } catch (error) {
    console.error(
      "Payment status lookup failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to check payment status.",
    });
  }
}

// ============================================================
// STITCH SVIX WEBHOOK SIGNATURE VERIFICATION
// ============================================================

function verifyStitchWebhookSignature(req) {
  const secret = process.env.STITCH_WEBHOOK_SECRET;
  const rawBody = req.rawBody;

  const webhookId = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signatureHeader = req.headers["svix-signature"];

  if (
    typeof secret !== "string" ||
    !secret.startsWith("whsec_") ||
    !Buffer.isBuffer(rawBody) ||
    typeof webhookId !== "string" ||
    !webhookId ||
    typeof timestamp !== "string" ||
    !/^\d+$/.test(timestamp) ||
    typeof signatureHeader !== "string"
  ) {
    return false;
  }

  const timestampSeconds = Number(timestamp);

  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(
      Math.floor(Date.now() / 1000) - timestampSeconds
    ) > WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const secretBytes = Buffer.from(
    secret.slice("whsec_".length),
    "base64"
  );

  if (!secretBytes.length) {
    return false;
  }

  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`, "utf8"),
    rawBody,
  ]);

  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest();

  const signatures = signatureHeader.split(" ");

  for (const item of signatures) {
    const [version, receivedSignature] = item.split(",", 2);

    if (
      version !== "v1" ||
      typeof receivedSignature !== "string"
    ) {
      continue;
    }

    const received = Buffer.from(
      receivedSignature,
      "base64"
    );

    if (
      received.length === expectedSignature.length &&
      crypto.timingSafeEqual(received, expectedSignature)
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// STITCH EXPRESS WEBHOOK
// POST /api/payments/stitch/webhook
// ============================================================

export async function stitchWebhook(req, res) {
  try {
    if (!verifyStitchWebhookSignature(req)) {
      console.warn(
        "Rejected Stitch webhook: invalid signature."
      );

      return res.status(400).send(
        "Invalid webhook signature"
      );
    }

    let event;

    try {
      event = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid webhook JSON");
    }

    // Stitch Express sends these fields directly in the body.
    const webhookId = req.headers["svix-id"];

    if (
      !event ||
      typeof event.id !== "string" ||
      typeof event.status !== "string" ||
      typeof event.amount !== "number" ||
      typeof event.type !== "string"
    ) {
      return res.status(400).send("Invalid payment event");
    }

    // This SA LIVE integration creates payment links only.
    if (event.type !== "LINK") {
      return res.status(200).send("Event ignored");
    }

    if (event.status !== "PAID") {
      return res.status(200).send("Event ignored");
    }

    if (
      typeof event.linkId !== "string" ||
      !event.linkId
    ) {
      return res.status(400).send("Missing payment link ID");
    }

    const paymentLink = await getStitchPaymentLink(
      event.linkId
    );

    const reference = paymentLink.merchantReference;

    if (!isValidReference(reference)) {
      return res.status(400).send("Unknown payment reference");
    }

    const payment = await getPaymentByReference(reference);

    if (
      !payment ||
      payment.provider !== "stitch" ||
      payment.reference !== reference ||
      payment.stitchPaymentLinkId !== event.linkId ||
      payment.currency !== "ZAR" ||
      payment.amountCents !== paymentLink.amount ||
      event.amount !== payment.amountCents
    ) {
      return res.status(400).send("Local payment mismatch");
    }

    // Confirm the actual payment through Stitch's API.
    // The webhook itself never credits the customer.
    const result = await verifyAndCreditPayment(
      payment,
      webhookId
    );

    console.info("Stitch Express webhook processed:", {
      reference,
      paymentLinkId: event.linkId,
      eventId: webhookId,
      credited: result.credited === true,
      alreadyCredited: result.alreadyCredited === true,
      status: result.status,
    });

    return res.status(200).send("OK");
  } catch (error) {
    console.error(
      "Stitch webhook processing failed:",
      error.message
    );

    return res.status(500).send(
      "Webhook processing failed"
    );
  }
}

// ============================================================
// CUSTOMER RETURN CALLBACK
// GET /api/payments/callback
// ============================================================

function setSecurityHeaders(res) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPaymentPage({
  title,
  heading,
  message,
  minutes,
}) {
  const minutesHtml =
    Number.isSafeInteger(minutes) && minutes > 0
      ? `<p>Minutes credited: <strong>${minutes}</strong></p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      box-sizing: border-box;
      display: grid;
      place-items: center;
      background: #020617;
      color: #f8fafc;
      font-family: Arial, sans-serif;
    }
    main {
      width: 100%;
      max-width: 460px;
      padding: 32px;
      box-sizing: border-box;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 18px;
    }
    h1 { color: #4ade80; }
    p { line-height: 1.7; color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    ${minutesHtml}
    <p>You can return to SA LIVE.</p>
  </main>
</body>
</html>`;
}

function sendPaymentPage(res, statusCode, page) {
  setSecurityHeaders(res);

  return res
    .status(statusCode)
    .type("html")
    .send(page);
}

export async function paymentCallback(req, res) {
  try {
    const reference =
      req.query?.reference ??
      req.query?.merchantReference;

    if (!isValidReference(reference)) {
      return sendPaymentPage(
        res,
        400,
        renderPaymentPage({
          title: "SA LIVE Payment",
          heading: "Payment status unavailable",
          message:
            "The payment reference is invalid. Return to SA LIVE and check your balance.",
        })
      );
    }

    const payment = await getPaymentByReference(reference);

    if (!payment) {
      return sendPaymentPage(
        res,
        404,
        renderPaymentPage({
          title: "SA LIVE Payment",
          heading: "Payment not found",
          message:
            "We could not find this payment. Return to SA LIVE or contact support.",
        })
      );
    }

    if (
      payment.status === "pending" &&
      payment.stitchPaymentLinkId
    ) {
      await verifyAndCreditPayment(payment);
    }

    const updatedPayment = await getPaymentByReference(reference);

    if (
      updatedPayment.status === "complete" &&
      updatedPayment.credited === true
    ) {
      return sendPaymentPage(
        res,
        200,
        renderPaymentPage({
          title: "SA LIVE Payment Successful",
          heading: "Payment successful",
          message:
            "Your payment has been confirmed. Your minutes are available in SA LIVE.",
          minutes: updatedPayment.minutes,
        })
      );
    }

    if (updatedPayment.status === "pending") {
      return sendPaymentPage(
        res,
        200,
        renderPaymentPage({
          title: "SA LIVE Payment Pending",
          heading: "Payment confirmation pending",
          message:
            "Your payment has not been confirmed yet. Check your SA LIVE balance shortly. Do not pay again until you have checked the original transaction.",
        })
      );
    }

    return sendPaymentPage(
      res,
      200,
      renderPaymentPage({
        title: "SA LIVE Payment",
        heading: "Payment not confirmed",
        message:
          "Your payment has not been confirmed as successful. Check your balance in SA LIVE.",
      })
    );
  } catch (error) {
    console.error(
      "Stitch return callback failed:",
      error.message
    );

    return sendPaymentPage(
      res,
      500,
      renderPaymentPage({
        title: "SA LIVE Payment",
        heading: "Unable to check payment",
        message:
          "We could not retrieve your payment status. Please try again shortly.",
      })
    );
  }
}