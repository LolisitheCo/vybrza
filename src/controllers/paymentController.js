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
// PAYFAST CONFIGURATION
// ============================================================

const PAYFAST_HOSTS = {
  live: "www.payfast.co.za",
  sandbox: "sandbox.payfast.co.za",
};

function getPayfastMode() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (!Object.hasOwn(PAYFAST_HOSTS, mode)) {
    throw new Error("Invalid PayFast mode.");
  }

  return mode;
}

function getPassphrase() {
  const passphrase =
    process.env.PAYFAST_PASSPHRASE;

  if (
    typeof passphrase !== "string" ||
    !passphrase.trim()
  ) {
    throw new Error(
      "PAYFAST_PASSPHRASE is missing."
    );
  }

  return passphrase;
}

function getMerchantId() {
  const merchantId =
    process.env.PAYFAST_MERCHANT_ID;

  if (!/^\d{8}$/.test(merchantId || "")) {
    throw new Error(
      "PAYFAST_MERCHANT_ID is invalid."
    );
  }

  return merchantId;
}

// ============================================================
// GENERAL HELPERS
// ============================================================

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

function sendPaymentPage(
  res,
  statusCode,
  page
) {
  return res
    .status(statusCode)
    .type("html")
    .send(page);
}

// ============================================================
// PAYFAST SIGNATURE VERIFICATION
// ============================================================

function payfastEncode(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (character) => {
      return (
        "%" +
        character
          .charCodeAt(0)
          .toString(16)
          .toUpperCase()
      );
    });
}

function buildPayfastParameterString(
  fields,
  includePassphrase = true
) {
  const parts = [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (key === "signature") {
      continue;
    }

    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ""
    ) {
      continue;
    }

    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number"
    ) {
      throw new Error(
        "Unexpected PayFast notification field."
      );
    }

    parts.push(
      `${key}=${payfastEncode(rawValue)}`
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
  const receivedSignature = fields.signature;

  if (
    typeof receivedSignature !== "string" ||
    !/^[a-f0-9]{32}$/i.test(receivedSignature)
  ) {
    return false;
  }

  const parameterString =
    buildPayfastParameterString(fields);

  const expectedSignature = crypto
    .createHash("md5")
    .update(parameterString, "utf8")
    .digest();

  const actualSignature = Buffer.from(
    receivedSignature,
    "hex"
  );

  return (
    actualSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(
      actualSignature,
      expectedSignature
    )
  );
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
    (addressNumber & mask) >>> 0 ===
    (networkNumber & mask) >>> 0
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

  /*
   * PayFast's published ITN source ranges.
   * Review against current official documentation periodically.
   *
   * Do not trust X-Forwarded-For directly. Configure Express's
   * trusted proxy settings correctly if deployed behind a proxy.
   */

  const ranges = [
    "197.97.145.144/28",
    "41.74.179.192/27",
    "102.216.36.0/28",
    "102.216.36.128/28",
    "144.126.193.139/32",
  ];

  return ranges.some(
    (range) => isIPv4InCidr(address, range)
  );
}

// ============================================================
// SERVER-TO-SERVER ITN VALIDATION
// ============================================================

async function validatePayfastWithServer(fields) {
  const mode = getPayfastMode();
  const host = PAYFAST_HOSTS[mode];

  const parameterString =
    buildPayfastParameterString(
      fields,
      false
    );

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
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `PayFast validation endpoint returned HTTP ${response.status}.`
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

export async function initializePayment(req, res) {
  let reference;

  try {
    const {
      userId,
      packageId,
      email,
    } = req.body ?? {};

    /*
     * SECURITY:
     * This preserves the existing request contract, but userId
     * must ultimately come from a verified Telegram identity or
     * authenticated server session. Do not trust an arbitrary
     * userId supplied by a public client.
     */

    if (
      typeof userId !== "string" ||
      !userId.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid user ID is required.",
      });
    }

    if (
      typeof packageId !== "string" ||
      !packageId.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid package ID is required.",
      });
    }

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email.trim()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    const paymentPackage =
      getPaymentPackage(packageId);

    if (!paymentPackage) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment package.",
      });
    }

    reference =
      `SALIVE-${crypto.randomUUID()
        .replace(/-/g, "")
        .toUpperCase()}`;

    // Create the server-side payment record first.
    await createPaymentRecord({
      userId: userId.trim(),
      reference,
      packageId,
      email: email.trim().toLowerCase(),
    });

    const checkout =
      await initializePayfastTransaction({
        email: email.trim().toLowerCase(),
        amount: paymentPackage.amount,
        reference,
        metadata: {
          custom_str1: packageId,
        },
      });

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

        // Submit these fields using an HTML POST form.
        paymentUrl: checkout.paymentUrl,
        fields: checkout.fields,
      },
    });
  } catch (error) {
    console.error(
      "Initialize PayFast payment error:",
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
    const reference = req.params.reference;

    if (
      typeof reference !== "string" ||
      !reference.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is required.",
      });
    }

    const payment =
      await getPaymentByReference(
        reference.trim()
      );

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found.",
      });
    }

    /*
     * Status is read from Firestore. This endpoint does not
     * credit minutes based on a client request.
     */

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
      "Payment status error:",
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
      Object.keys(fields).length === 0
    ) {
      return res.status(400).send("Invalid notification");
    }

    /*
     * Express must parse the ITN body using
     * express.urlencoded({ extended: false }).
     */

    const remoteAddress =
      normalizeRemoteAddress(req.ip || req.socket?.remoteAddress);

    if (!isPayfastSourceIp(remoteAddress)) {
      console.warn(
        "Rejected PayFast ITN from unrecognized source IP:",
        remoteAddress
      );

      return res.status(403).send("Forbidden");
    }

    if (!verifyPayfastSignature(fields)) {
      console.warn(
        "Rejected PayFast ITN: invalid signature."
      );

      return res.status(400).send("Invalid signature");
    }

    const expectedMerchantId =
      getMerchantId();

    if (
      String(fields.merchant_id) !==
      expectedMerchantId
    ) {
      return res.status(400).send("Invalid merchant");
    }

    const reference = fields.m_payment_id;

    if (
      typeof reference !== "string" ||
      !reference.trim()
    ) {
      return res.status(400).send("Missing payment reference");
    }

    const payment =
      await getPaymentByReference(
        reference.trim()
      );

    if (!payment) {
      return res.status(404).send("Unknown payment");
    }

    // Do not process an unexpected payment provider or currency.
    if (
      payment.provider !== "payfast" ||
      payment.currency !== "ZAR"
    ) {
      return res.status(400).send("Payment mismatch");
    }

    const expectedAmount = Number(payment.amount);
    const receivedGross = Number(fields.amount_gross);

    if (
      !Number.isFinite(expectedAmount) ||
      !Number.isFinite(receivedGross) ||
      Math.abs(expectedAmount - receivedGross) > 0.01
    ) {
      console.warn(
        "PayFast amount mismatch:",
        reference
      );

      return res.status(400).send("Amount mismatch");
    }

    /*
     * PayFast can send notifications for different statuses.
     * Only COMPLETE payments may credit call minutes.
     */

    if (fields.payment_status !== "COMPLETE") {
      console.info(
        "PayFast notification received with non-complete status:",
        fields.payment_status
      );

      // A non-complete notification does not credit minutes.
      return res.status(200).send("OK");
    }

    /*
     * Final server-to-server confirmation.
     * No balance update occurs unless PayFast confirms VALID.
     */

    const serverConfirmed =
      await validatePayfastWithServer(fields);

    if (!serverConfirmed) {
      console.warn(
        "PayFast server validation failed:",
        reference
      );

      return res.status(400).send("Validation failed");
    }

    /*
     * This Firestore transaction is idempotent:
     * duplicate COMPLETE notifications cannot credit twice.
     */

    const result =
      await creditSuccessfulPayment(
        reference.trim()
      );

    console.info(
      "PayFast ITN processed:",
      reference,
      result.alreadyCredited
        ? "already credited"
        : "minutes credited"
    );

    return res.status(200).send("OK");
  } catch (error) {
    console.error(
      "PayFast ITN processing error:",
      error.message
    );

    /*
     * A non-2xx response permits notification retries.
     * Investigate errors before manually changing balances.
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
      req.query.m_payment_id ||
      req.query.reference;

    if (
      typeof reference !== "string" ||
      !reference.trim()
    ) {
      return sendPaymentPage(
        res,
        400,
        renderPaymentPage({
          title: "SA LIVE Payment",
          heading: "Payment status unavailable",
          message:
            "The payment reference is missing. Return to Telegram and check your balance.",
        })
      );
    }

    const payment =
      await getPaymentByReference(
        reference.trim()
      );

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
     * Do not trust the return URL as proof of payment.
     * The ITN handler is responsible for crediting minutes.
     */

    if (
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
            "Your payment has been confirmed and your call minutes are available.",
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
            "We have not confirmed your payment yet. Please wait briefly, then check your balance in Telegram. Do not pay again unless your payment status confirms that the original transaction failed.",
        })
      );
    }

    return sendPaymentPage(
      res,
      200,
      renderPaymentPage({
        title: "SA LIVE Payment",
        heading: "Payment not completed",
        message:
          "Your payment has not been confirmed. Return to Telegram to check its status.",
      })
    );
  } catch (error) {
    console.error(
      "PayFast return callback error:",
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