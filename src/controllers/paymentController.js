
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
  getStitchPayment,
  getStitchPaymentLink,
} from "../services/stitchService.js";

// ============================================================
// SA LIVE — STITCH EXPRESS PAYMENT CONTROLLER
// Stitch Express is the only supported payment provider.
// ============================================================

const PAYMENT_REFERENCE_PATTERN = /^SALIVE-[A-F0-9]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const WEBHOOK_TOLERANCE_SECONDS = 300;

// ============================================================
// AUTHENTICATION HELPERS
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

// ============================================================
// INPUT VALIDATION
// ============================================================

function isValidReference(reference) {
  return (
    typeof reference === "string" &&
    PAYMENT_REFERENCE_PATTERN.test(reference)
  );
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= MAX_EMAIL_LENGTH &&
    email === email.trim() &&
    EMAIL_PATTERN.test(email)
  );
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
    payment.amountCents ===
      Math.round(paymentPackage.amount * 100)
  );
}

// ============================================================
// CHECKOUT CREATION
// ============================================================

async function createCheckoutForPayment(payment) {
  const checkout = await createStitchPaymentLink({
    reference: payment.reference,
    amountCents: payment.amountCents,
    email: payment.email,
    payerName: "SA LIVE Customer",
  });

  await attachStitchPaymentLink({
    reference: payment.reference,
    paymentLinkId: checkout.paymentLinkId,
    redirectUrl: checkout.redirectUrl,
  });

  return checkout;
}

// ============================================================
// HTML RESPONSE HELPERS
// ============================================================

function setSecurityHeaders(res) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
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

// ============================================================
// INITIALIZE A NEW PAYMENT
// ============================================================

export async function initializePayment(req, res) {
  try {
    const authenticatedUserId =
      getAuthenticatedUserId(req);

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const {
      userId,
      packageId,
      email,
    } = req.body ?? {};

    // Never allow the request body to choose another user.
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

    const reference =
      `SALIVE-${crypto.randomUUID()
        .replace(/-/g, "")
        .toUpperCase()}`;

    // Create the trusted pending Firestore record first.
    await createPaymentRecord({
      userId: authenticatedUserId,
      reference,
      packageId: paymentPackage.id,
      email: email.toLowerCase(),
    });

    const payment = await getPaymentByReference(reference);

    if (!payment || payment.provider !== "stitch") {
      throw new Error(
        "Stitch payment record was not created correctly."
      );
    }

    const checkout = await createCheckoutForPayment(payment);

    return res.status(200).json({
      success: true,
      message: "Stitch checkout created.",
      payment: {
        reference,
        packageId: paymentPackage.id,
        packageName: paymentPackage.name,
        amount: paymentPackage.amount,
        amountCents: checkout.amountCents,
        currency: "ZAR",
        minutes: paymentPackage.minutes,
        redirectUrl: checkout.redirectUrl,
        provider: "stitch",
      },
    });
  } catch (error) {
    console.error(
      "Initialize Stitch payment failed:",
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
// RECREATE OR RETURN AN EXISTING CHECKOUT
// ============================================================

export async function initializeExistingPaymentCheckout(req, res) {
  try {
    const reference = req.params?.reference;

    if (!isValidReference(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference.",
      });
    }

    const authenticatedUserId =
      getAuthenticatedUserId(req);

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const payment =
      await getPaymentByReference(reference);

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

    // Reuse the same pending payment link when available.
    if (
      typeof payment.stitchPaymentLinkId === "string" &&
      typeof payment.stitchRedirectUrl === "string"
    ) {
      return res.status(200).json({
        success: true,
        provider: "stitch",
        reference,
        redirectUrl: payment.stitchRedirectUrl,
      });
    }

    if (!isValidEmail(payment.email)) {
      return res.status(409).json({
        success: false,
        message:
          "A valid payment email is missing. Please update your email.",
      });
    }

    const checkout = await createCheckoutForPayment(payment);

    return res.status(200).json({
      success: true,
      provider: "stitch",
      reference,
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
// ============================================================

export async function verifyPayment(req, res) {
  try {
    const authenticatedUserId =
      getAuthenticatedUserId(req);

    if (!authenticatedUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const reference = req.params?.reference;

    if (!isValidReference(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference.",
      });
    }

    const payment =
      await getPaymentByReference(reference);

    if (!isPaymentOwner(payment, authenticatedUserId)) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found.",
      });
    }

    return res.status(200).json({
      success: true,
      payment: {
        reference: payment.reference,
        provider: payment.provider,
        status: payment.status,
        credited: payment.credited === true,
        minutes: payment.minutes,
        amount: payment.amount,
        currency: payment.currency,
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
// STITCH WEBHOOK SIGNATURE VERIFICATION
// Svix signature + raw request body
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

  let secretBytes;

  try {
    secretBytes = Buffer.from(
      secret.slice("whsec_".length),
      "base64"
    );
  } catch {
    return false;
  }

  if (!secretBytes.length) {
    return false;
  }

  const signedContent = Buffer.concat([
    Buffer.from(
      `${webhookId}.${timestamp}.`,
      "utf8"
    ),
    rawBody,
  ]);

  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  const signatures = signatureHeader.split(" ");

  for (const item of signatures) {
    const [version, receivedSignature] =
      item.split(",", 2);

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

    const expected = Buffer.from(
      expectedSignature,
      "base64"
    );

    if (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// STITCH PAYMENT.PAID WEBHOOK
// ============================================================

export async function stitchWebhook(req, res) {
  try {
    // Verify the signature before trusting any event data.
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
      return res.status(400).send(
        "Invalid webhook JSON"
      );
    }

    const webhookId = req.headers["svix-id"];

    if (
      !event ||
      typeof event !== "object" ||
      event.status !== "PAID" ||
      event.type !== "LINK" ||
      typeof event.id !== "string" ||
      typeof event.linkId !== "string" ||
      !Number.isSafeInteger(event.amount) ||
      event.amount < 100
    ) {
      // Only payment.paid link payments are relevant to SA LIVE.
      return res.status(400).send(
        "Invalid Stitch payment event"
      );
    }

    // Retrieve the link directly from Stitch.
    const paymentLink =
      await getStitchPaymentLink(event.linkId);

    if (
      !paymentLink ||
      paymentLink.id !== event.linkId ||
      paymentLink.status !== "PAID" ||
      paymentLink.amount !== event.amount ||
      typeof paymentLink.merchantReference !== "string" ||
      paymentLink.paymentId !== event.id
    ) {
      console.warn(
        "Stitch payment-link verification mismatch:",
        event.linkId
      );

      return res.status(400).send(
        "Payment-link verification failed"
      );
    }

    const reference = paymentLink.merchantReference;

    if (!isValidReference(reference)) {
      console.warn(
        "Stitch webhook contained an unknown merchant reference."
      );

      return res.status(400).send(
        "Unknown payment reference"
      );
    }

    const localPayment =
      await getPaymentByReference(reference);

    if (
      !localPayment ||
      localPayment.provider !== "stitch" ||
      localPayment.reference !== reference ||
      localPayment.stitchPaymentLinkId !== event.linkId ||
      localPayment.amountCents !== event.amount ||
      localPayment.currency !== "ZAR"
    ) {
      console.warn(
        "Stitch webhook did not match a local payment:",
        reference
      );

      return res.status(400).send(
        "Local payment mismatch"
      );
    }

    // Retrieve the actual payment, not just the payment link.
    const confirmedPayment =
      await getStitchPayment(event.id);

    if (
      !confirmedPayment ||
      confirmedPayment.id !== event.id ||
      !["PAID", "SETTLED"].includes(confirmedPayment.status) ||
      confirmedPayment.type !== "LINK" ||
      confirmedPayment.amount !== localPayment.amountCents ||
      confirmedPayment.merchantReference !== reference
    ) {
      console.warn(
        "Stitch payment verification failed:",
        reference
      );

      return res.status(400).send(
        "Payment verification failed"
      );
    }

    // This function MUST credit inside a Firestore transaction
    // and refuse to credit an already credited payment.
    const result = await creditSuccessfulPayment(
      reference,
      {
        paymentId: confirmedPayment.id,
        eventId: webhookId,
        paymentLinkId: event.linkId,
      }
    );

    console.info("Stitch payment webhook processed:", {
      reference,
      eventId: webhookId,
      alreadyCredited: result?.alreadyCredited === true,
    });

    return res.status(200).send("OK");
  } catch (error) {
    console.error(
      "Stitch webhook processing failed:",
      error.message
    );

    // Non-2xx response allows Stitch to retry the delivery.
    return res.status(500).send(
      "Webhook processing failed"
    );
  }
}

// ============================================================
// CUSTOMER RETURN CALLBACK
// A browser redirect is NOT proof of payment.
// ============================================================

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

    const payment =
      await getPaymentByReference(reference);

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
      payment.provider === "stitch" &&
      payment.status === "complete" &&
      payment.credited === true
    ) {
      return sendPaymentPage(
        res,
        200,
        renderPaymentPage({
          title: "SA LIVE Payment Successful",
          heading: "Payment successful",
          message:
            "Your payment has been confirmed. Your minutes are available in SA LIVE.",
          minutes: payment.minutes,
        })
      );
    }

    if (payment.status === "pending") {
      return sendPaymentPage(
        res,
        200,
        renderPaymentPage({
          title: "SA LIVE Payment Pending",
          heading: "Payment confirmation pending",
          message:
            "Your payment has not been confirmed yet. Check your balance shortly. Do not pay again until you have checked the original transaction.",
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
