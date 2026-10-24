
import crypto from "node:crypto";

import {
  getPaymentPackage,
  createPaymentRecord,
  getPaymentByReference,
  creditSuccessfulPayment,
} from "../services/paymentService.js";

import {
  initializePayfastTransaction,
} from "../services/payfastService.js";

// ============================================================
// CONFIGURATION
// ============================================================

const PAYFAST_HOSTS = Object.freeze({
  live: "www.payfast.co.za",
  sandbox: "sandbox.payfast.co.za",
});

const PAYMENT_REFERENCE_PATTERN = /^SALIVE-[A-F0-9]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ITN_FIELDS = 100;
const REQUEST_TIMEOUT_MS = 15000;

const PAYFAST_SOURCE_RANGES = Object.freeze([
  "197.97.145.144/28",
  "41.74.179.192/27",
  "102.216.36.0/28",
  "102.216.36.128/28",
  "144.126.193.139/32",
]);


function getPassphrase() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (mode !== "live" && mode !== "sandbox") {
    throw new Error("PAYFAST_MODE must be live or sandbox.");
  }

  const variableName =
    mode === "sandbox"
      ? "PAYFAST_SANDBOX_PASSPHRASE"
      : process.env.PAYFAST_LIVE_PASSPHRASE
        ? "PAYFAST_LIVE_PASSPHRASE"
        : "PAYFAST_PASSPHRASE";

  const value = process.env[variableName];

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 32
  ) {
    throw new Error(
      `${variableName} is missing or invalid.`
    );
  }

  return value;
}



function getMerchantId() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (mode !== "live" && mode !== "sandbox") {
    throw new Error("PAYFAST_MODE must be live or sandbox.");
  }

  const variableName =
    mode === "sandbox"
      ? "PAYFAST_SANDBOX_MERCHANT_ID"
      : process.env.PAYFAST_LIVE_MERCHANT_ID
        ? "PAYFAST_LIVE_MERCHANT_ID"
        : "PAYFAST_MERCHANT_ID";

  const merchantId = process.env[variableName];

  if (
    typeof merchantId !== "string" ||
    !/^\d{8}$/.test(merchantId.trim())
  ) {
    throw new Error(`${variableName} is missing or invalid.`);
  }

  return merchantId.trim();
}



// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

/*
 * Authentication middleware must establish the identity from
 * a verified session, Firebase token, or verified Telegram
 * identity. Never establish identity from an arbitrary body ID.
 *
 * Adapt the property names here to match your existing,
 * trusted authentication middleware.
 */

function getAuthenticatedUserId(req) {
  const candidates = [
    req.authenticatedUserId,
    req.user?.uid,
    req.user?.telegramId,
    req.auth?.uid,
    req.auth?.telegramId,
  ];

  for (const candidate of candidates) {
    if (
      (typeof candidate === "string" ||
        typeof candidate === "number") &&
      String(candidate).trim() &&
      String(candidate).length <= 128
    ) {
      return String(candidate).trim();
    }
  }

  return null;
}

function isPaymentOwner(payment, userId) {
  return (
    payment &&
    userId &&
    String(payment.userId) === userId
  );
}

// ============================================================
// HTTP RESPONSE HELPERS
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
    <p>You can return to Telegram.</p>
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
    email.length <= 254 &&
    email === email.trim() &&
    EMAIL_PATTERN.test(email)
  );
}

function isScalarPayfastField(value) {
  return (
    typeof value === "string" ||
    (typeof value === "number" &&
      Number.isFinite(value))
  );
}

// ============================================================
// PAYFAST SIGNATURE VERIFICATION
// ============================================================

/*
 * PayFast-compatible URL encoding.
 * Spaces must become "+" and special characters must use
 * uppercase percent-encoding.
 */
function payfastEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}



function getPayfastMode() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (mode !== "live" && mode !== "sandbox") {
    throw new Error(
      "PAYFAST_MODE must be either live or sandbox."
    );
  }

  return mode;
}



function buildPayfastParameterString(
  fields,
  includePassphrase = true
) {
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    if (key === "signature") {
      continue;
    }

    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9_]+$/.test(key)
    ) {
      throw new Error("Invalid PayFast parameter name.");
    }

    if (!isScalarPayfastField(value)) {
      throw new Error("Invalid PayFast parameter value.");
    }

    const normalizedValue = String(value).trim();

    if (normalizedValue === "") {
      continue;
    }

    parts.push(
      `${key}=${payfastEncode(normalizedValue)}`
    );
  }

  if (includePassphrase) {
    parts.push(
      `passphrase=${payfastEncode(getPassphrase())}`
    );
  }

  return parts.join("&");
}

function verifyPayfastSignature(fields) {
  try {
    const receivedSignature = fields.signature;

    if (
      typeof receivedSignature !== "string" ||
      !/^[a-f0-9]{32}$/i.test(receivedSignature)
    ) {
      return false;
    }

    const parameterString =
      buildPayfastParameterString(fields, true);

    const expectedSignature = crypto
      .createHash("md5")
      .update(parameterString, "utf8")
      .digest();

    const actualSignature = Buffer.from(
      receivedSignature,
      "hex"
    );

    console.info("PayFast signature diagnostic:", {
  receivedSignatureLength: receivedSignature.length,
  parameterCount: Object.keys(fields).length,
  passphraseConfigured:
    Boolean(process.env.PAYFAST_SANDBOX_PASSPHRASE),
  mode: getPayfastMode(),
});

    return (
      actualSignature.length === expectedSignature.length &&
      crypto.timingSafeEqual(
        actualSignature,
        expectedSignature
      )
    );
  } catch {
    return false;
  }
}

// ============================================================
// PAYFAST SOURCE IP VALIDATION
// ============================================================

function ipv4ToNumber(ip) {
  const parts = ip.split(".");

  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !/^\d{1,3}$/.test(part) ||
        Number(part) > 255
    )
  ) {
    return null;
  }

  return parts.reduce(
    (result, part) =>
      ((result << 8) | Number(part)) >>> 0,
    0
  );
}

function isIPv4InCidr(ip, cidr) {
  const [network, prefixText] = cidr.split("/");
  const addressNumber = ipv4ToNumber(ip);
  const networkNumber = ipv4ToNumber(network);
  const prefix = Number(prefixText);

  if (
    addressNumber === null ||
    networkNumber === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  const mask =
    prefix === 0
      ? 0
      : (0xffffffff << (32 - prefix)) >>> 0;

  return (
    ((addressNumber & mask) >>> 0) ===
    ((networkNumber & mask) >>> 0)
  );
}

function normalizeRemoteAddress(address) {
  if (typeof address !== "string") {
    return "";
  }

  const normalized = address.trim();

  if (normalized.startsWith("::ffff:")) {
    return normalized.slice(7);
  }

  return normalized;
}

function isPayfastSourceIp(ip) {
  const address = normalizeRemoteAddress(ip);

  return PAYFAST_SOURCE_RANGES.some((range) =>
    isIPv4InCidr(address, range)
  );
}

// ============================================================
// PAYFAST SERVER-TO-SERVER ITN VALIDATION
// ============================================================

async function validatePayfastWithServer(fields) {
  const mode = getPayfastMode();
  const host = PAYFAST_HOSTS[mode];

  const parameterString =
    buildPayfastParameterString(fields, false);

  const response = await fetch(
    `https://${host}/eng/query/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "text/plain",
      },
      body: parameterString,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    }
  );

  if (!response.ok) {
    throw new Error(
      `PayFast validation returned HTTP ${response.status}.`
    );
  }

  const responseText = (
    await response.text()
  ).trim();

  return responseText === "VALID";
}

// ============================================================
// INITIALIZE PAYMENT
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

    // The reference is a high-entropy bearer token created by
    // the Telegram bot. Never accept price or email from the browser.
    const payment = await getPaymentByReference(reference);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found. Please restart checkout in Telegram.",
      });
    }

    if (
      payment.reference !== reference ||
      payment.provider !== "payfast" ||
      payment.currency !== "ZAR" ||
      payment.status !== "pending" ||
      payment.credited === true
    ) {
      return res.status(409).json({
        success: false,
        message:
          "This payment is no longer available for checkout. Check your balance in Telegram.",
      });
    }

    const paymentPackage = getPaymentPackage(payment.packageId);

    if (
      !paymentPackage ||
      payment.amount !== paymentPackage.amount ||
      payment.minutes !== paymentPackage.minutes ||
      payment.amountCents !== Math.round(paymentPackage.amount * 100)
    ) {
      console.error("Stored payment package mismatch:", reference);

      return res.status(409).json({
        success: false,
        message: "The stored payment details could not be verified.",
      });
    }

    if (!isValidEmail(payment.email)) {
      return res.status(409).json({
        success: false,
        message:
          "A valid payment email is missing. Please update your email in Telegram.",
      });
    }

    const checkout = await initializePayfastTransaction({
      email: payment.email,
      amount: paymentPackage.amount,
      reference,
      metadata: {
        custom_str1: paymentPackage.id,
      },
    });

    const expectedHost = PAYFAST_HOSTS[getPayfastMode()];
    const checkoutUrl = new URL(checkout.paymentUrl);

    if (
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== expectedHost ||
      !checkout.fields ||
      typeof checkout.fields !== "object" ||
      Array.isArray(checkout.fields)
    ) {
      throw new Error("Invalid PayFast checkout response.");
    }

    // Ensure the signed fields match this existing payment.
    if (
      checkout.fields.m_payment_id !== reference ||
      Number(checkout.fields.amount) !== paymentPackage.amount ||
      checkout.fields.email_address !== payment.email
    ) {
      throw new Error("PayFast fields do not match the stored payment.");
    }

    return res.status(200).json({
      success: true,
      paymentUrl: checkout.paymentUrl,
      fields: checkout.fields,
    });
  } catch (error) {
    console.error(
      "Existing PayFast checkout failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to prepare checkout. Please try again shortly.",
    });
  }
}



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

    /*
     * If the existing client sends userId, it must match the
     * authenticated identity. It can never select another user.
     */

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

    if (
      typeof email !== "string" ||
      !isValidEmail(email)
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    const paymentPackage =
      getPaymentPackage(packageId);

    if (
      !paymentPackage ||
      !Number.isSafeInteger(paymentPackage.minutes) ||
      paymentPackage.minutes <= 0 ||
      !Number.isFinite(Number(paymentPackage.amount)) ||
      Number(paymentPackage.amount) <= 0
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

    const normalizedEmail = email.toLowerCase();

    /*
     * Store the pending payment before creating checkout.
     * Package price and minutes must come from the trusted
     * server-side package configuration/service.
     */

    await createPaymentRecord({
      userId: authenticatedUserId,
      reference,
      packageId: paymentPackage.id,
      email: normalizedEmail,
    });

    console.info("PAYMENT CONTROLLER HANDOFF:", {
  referenceType: typeof reference,
  referenceLength: reference.length,
  referenceFormatValid:
    /^SALIVE-[A-F0-9]{32}$/.test(reference),
});

     
const checkout = await initializePayfastTransaction({
  email: normalizedEmail,
  amount: paymentPackage.amount,
  reference,
  metadata: {
    custom_str1: paymentPackage.id,
  },
});

console.info("SA LIVE checkout initialized:", {
  referenceFormatValid:
    typeof reference === "string" &&
    /^SALIVE-[A-F0-9]{32}$/.test(reference),
  checkoutCreated: Boolean(checkout),
  paymentUrlProvided:
    typeof checkout?.paymentUrl === "string",
});


    if (
  !checkout ||
  typeof checkout.paymentUrl !== "string" ||
  !checkout.fields ||
  typeof checkout.fields !== "object" ||
  Array.isArray(checkout.fields) ||
  !checkout.paymentUrl.startsWith("https://")
) {
  throw new Error("Invalid PayFast checkout response.");
}

    const expectedHost =
      PAYFAST_HOSTS[getPayfastMode()];

    const checkoutUrl = new URL(checkout.paymentUrl);

    if (
      checkoutUrl.hostname !== expectedHost ||
      checkoutUrl.protocol !== "https:"
    ) {
      throw new Error("Unexpected PayFast checkout host.");
    }

    return res.status(200).json({
      success: true,
      message: "Payment checkout created.",
      payment: {
        reference,
        packageId: paymentPackage.id,
        packageName: paymentPackage.name,
        amount: paymentPackage.amount,
        currency: "ZAR",
        minutes: paymentPackage.minutes,
        paymentUrl: checkout.paymentUrl,
        fields: checkout.fields,
      },
    });
  } catch (error) {
    console.error(
      "Initialize PayFast payment failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to initialize payment. Please try again.",
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

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found.",
      });
    }

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
// PAYFAST ITN WEBHOOK
// ============================================================

export async function paymentITN(req, res) {
  try {
    const fields = req.body;

    if (
      !fields ||
      typeof fields !== "object" ||
      Array.isArray(fields) ||
      Object.keys(fields).length === 0 ||
      Object.keys(fields).length > MAX_ITN_FIELDS
    ) {
      return res.status(400).send("Invalid notification");
    }

    /*
     * The Express route must parse this endpoint as URL-encoded
     * form data. Do not trust arbitrary forwarded IP headers.
     * Configure Express trusted proxies correctly in production.
     */

    const expressIp = normalizeRemoteAddress(req.ip || "");
const socketIp = normalizeRemoteAddress(
  req.socket?.remoteAddress || ""
);

const remoteAddress = expressIp || socketIp;

const cloudflareIp = normalizeRemoteAddress(
  typeof req.headers["cf-connecting-ip"] === "string"
    ? req.headers["cf-connecting-ip"]
    : ""
);

const sourceIpAllowed =
  isPayfastSourceIp(remoteAddress) ||
  (
    cloudflareIp !== "" &&
    isPayfastSourceIp(cloudflareIp)
  );

console.info("PayFast ITN proxy diagnostic:", {
  expressIp: req.ip,
  expressIps: req.ips,
  socketIp: req.socket?.remoteAddress,
  forwardedFor: req.headers["x-forwarded-for"] ?? null,
  cloudflareConnectingIp:
    req.headers["cf-connecting-ip"] ?? null,
  sourceIpAllowed,
});

if (!sourceIpAllowed) {
  console.warn(
    "Rejected PayFast ITN: source IP not allowlisted."
  );

  return res.status(403).send("Forbidden");
}

    if (!verifyPayfastSignature(fields)) {
      console.warn("Rejected PayFast ITN: invalid signature.");

      return res.status(400).send("Invalid signature");
    }

    if (
      typeof fields.merchant_id !== "string" &&
      typeof fields.merchant_id !== "number"
    ) {
      return res.status(400).send("Invalid merchant");
    }

    if (
      String(fields.merchant_id) !== getMerchantId()
    ) {
      return res.status(400).send("Invalid merchant");
    }

    const reference = fields.m_payment_id;

    if (!isValidReference(reference)) {
      return res.status(400).send("Invalid payment reference");
    }

    const payment =
      await getPaymentByReference(reference);

    if (!payment) {
      return res.status(404).send("Unknown payment");
    }

    if (
      payment.provider !== "payfast" ||
      payment.currency !== "ZAR"
    ) {
      return res.status(400).send("Payment mismatch");
    }

    /*
     * Compare integer cents to avoid floating-point money errors.
     */

    const expectedAmount = Number(payment.amount);
    const receivedGross = Number(fields.amount_gross);

    if (
      !Number.isFinite(expectedAmount) ||
      !Number.isFinite(receivedGross) ||
      expectedAmount <= 0 ||
      receivedGross <= 0 ||
      Math.round(expectedAmount * 100) !==
        Math.round(receivedGross * 100)
    ) {
      console.warn(
        "PayFast amount mismatch for reference:",
        reference
      );

      return res.status(400).send("Amount mismatch");
    }

    /*
     * Never credit minutes for FAILED, PENDING, CANCELLED,
     * or any other non-COMPLETE notification.
     */

    if (fields.payment_status !== "COMPLETE") {
      console.info(
        "PayFast non-complete notification:",
        fields.payment_status
      );

      return res.status(200).send("OK");
    }

    /*
     * Confirm the ITN directly with PayFast before touching
     * any account balance.
     */

    const serverConfirmed =
      await validatePayfastWithServer(fields);

    if (!serverConfirmed) {
      console.warn(
        "PayFast server validation failed for:",
        reference
      );

      return res.status(400).send("Validation failed");
    }

    /*
     * CRITICAL:
     * creditSuccessfulPayment MUST perform an atomic Firestore
     * transaction, validate the pending payment, and ensure that
     * the payment can only be credited once.
     *
     * This controller deliberately does not update balances.
     */

    const result =
      await creditSuccessfulPayment(reference);

    console.info(
      "PayFast ITN processed:",
      reference,
      result?.alreadyCredited
        ? "already credited"
        : "processed"
    );

    return res.status(200).send("OK");
  } catch (error) {
    console.error(
      "PayFast ITN processing failed:",
      error.message
    );

    /*
     * Return a failure status for transient processing errors
     * so the notification can be investigated or retried.
     */

    return res.status(500).send(
      "Notification processing failed"
    );
  }
}

// ============================================================
// CUSTOMER RETURN CALLBACK
// ============================================================

export async function paymentCallback(req, res) {
  try {
    const reference =
      req.query?.m_payment_id ??
      req.query?.reference;

    if (!isValidReference(reference)) {
      return sendPaymentPage(
        res,
        400,
        renderPaymentPage({
          title: "SA LIVE Payment",
          heading: "Payment status unavailable",
          message:
            "The payment reference is invalid. Return to Telegram and check your balance.",
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
            "We could not find this payment. Return to Telegram or contact support.",
        })
      );
    }

    /*
     * A browser redirect is not proof of payment.
     * Only the verified ITN processing flow can credit minutes.
     */

    if (
      payment.provider === "payfast" &&
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
            "Your payment has been confirmed. Your minutes are available in Telegram.",
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
            "Your payment has not been confirmed yet. Check your balance in Telegram shortly. Avoid making another payment until you have checked the original transaction.",
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
          "Your payment has not been confirmed as successful. Return to Telegram to check its status.",
      })
    );
  } catch (error) {
    console.error(
      "PayFast return callback failed:",
      error.message
    );

    return sendPaymentPage(
      res,
      500,
      renderPaymentPage({
        title: "SA LIVE Payment",
        heading: "Unable to check payment",
        message:
          "We could not retrieve your payment status. Return to Telegram and try again shortly.",
      })
    );
  }
}
