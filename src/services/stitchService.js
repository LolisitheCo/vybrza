
import "dotenv/config";

// ============================================================
// SA LIVE — STITCH EXPRESS PAYMENT SERVICE
// Hosted payment links + server-side payment verification
// ============================================================

const STITCH_BASE_URL = (
  process.env.STITCH_API_BASE_URL ||
  "https://express.stitch.money"
).replace(/\/+$/, "");

const STITCH_API_URL = `${STITCH_BASE_URL}/api/v1`;

const PAYMENT_REFERENCE_PATTERN = /^SALIVE-[A-F0-9]{32}$/;

const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_LIFETIME_MS = 14 * 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenRequestPromise = null;

// ------------------------------------------------------------
// ENVIRONMENT VALIDATION
// ------------------------------------------------------------

function requiredEnv(name) {
  const value = process.env[name];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is not configured.`);
  }

  return value.trim();
}

function getCredentials() {
  const clientId = requiredEnv("STITCH_CLIENT_ID");
  const clientSecret = requiredEnv("STITCH_CLIENT_SECRET");

  if (clientId.length > 500 || clientSecret.length > 2000) {
    throw new Error("Stitch credentials have an invalid length.");
  }

  return { clientId, clientSecret };
}

// ------------------------------------------------------------
// HTTP HELPERS
// ------------------------------------------------------------

async function stitchRequest(path, options = {}) {
  const token = await getStitchAccessToken();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${STITCH_API_URL}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const providerMessage = Array.isArray(result?.generalErrors)
        ? result.generalErrors.join("; ")
        : typeof result?.message === "string"
          ? result.message
          : `Stitch API request failed with HTTP ${response.status}.`;

      const error = new Error(providerMessage.slice(0, 300));
      error.status = response.status;
      error.provider = "stitch";

      throw error;
    }

    if (!result || result.success !== true) {
      throw new Error(
        "Stitch returned an unsuccessful or invalid response."
      );
    }

    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Stitch API request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// STITCH ACCESS TOKEN
// ------------------------------------------------------------

export async function getStitchAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (tokenRequestPromise) {
    return tokenRequestPromise;
  }

  tokenRequestPromise = (async () => {
    const credentials = getCredentials();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(`${STITCH_API_URL}/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          scope: "client_paymentrequest",
        }),
        signal: controller.signal,
      });

      const result = await response.json().catch(() => null);

      if (
        !response.ok ||
        result?.success !== true ||
        typeof result?.data?.accessToken !== "string" ||
        !result.data.accessToken
      ) {
        throw new Error(
          "Stitch authentication failed. Check your Stitch credentials and API access."
        );
      }

      cachedToken = result.data.accessToken;
      tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;

      return cachedToken;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Stitch authentication request timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })();

  try {
    return await tokenRequestPromise;
  } finally {
    tokenRequestPromise = null;
  }
}

// ------------------------------------------------------------
// VALIDATION
// ------------------------------------------------------------

function validateReference(reference) {
  if (
    typeof reference !== "string" ||
    !PAYMENT_REFERENCE_PATTERN.test(reference)
  ) {
    throw new Error("Invalid SA LIVE payment reference.");
  }
}

function validateAmount(amountCents) {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 100
  ) {
    throw new Error(
      "Stitch payment amount must be at least 100 cents."
    );
  }
}

function validateEmail(email) {
  if (email === undefined || email === null || email === "") {
    return undefined;
  }

  if (
    typeof email !== "string" ||
    email.length > 254 ||
    email !== email.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("Invalid customer email address.");
  }

  return email.toLowerCase();
}

function validatePayerName(payerName) {
  const name =
    typeof payerName === "string"
      ? payerName.trim()
      : "SA LIVE Customer";

  if (name.length < 3 || name.length > 40) {
    throw new Error(
      "Customer name must contain between 3 and 40 characters."
    );
  }

  return name;
}

function validateCheckoutUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Stitch returned an invalid payment link.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "express.stitch.money" ||
    url.username ||
    url.password
  ) {
    throw new Error("Stitch returned an untrusted checkout URL.");
  }

  return url.toString();
}

// ------------------------------------------------------------
// CREATE STITCH PAYMENT LINK
// ------------------------------------------------------------

export async function createStitchPaymentLink({
  reference,
  amountCents,
  email,
  payerName,
}) {
  validateReference(reference);
  validateAmount(amountCents);

  const customerEmail = validateEmail(email);
  const customerName = validatePayerName(payerName);

  const payload = {
    amount: amountCents,
    payerName: customerName,
    merchantReference: reference,
    ...(customerEmail
      ? { payerEmailAddress: customerEmail }
      : {}),
  };

  const result = await stitchRequest("/payment-links", {
    method: "POST",
    body: payload,
  });

  const payment = result?.data?.payment;

  if (
    !payment ||
    typeof payment.id !== "string" ||
    typeof payment.link !== "string" ||
    payment.amount !== amountCents ||
    payment.merchantReference !== reference
  ) {
    throw new Error(
      "Stitch returned incomplete or mismatched payment-link details."
    );
  }

  const redirectUrl = validateCheckoutUrl(payment.link);

  return {
    provider: "stitch",
    paymentLinkId: payment.id,
    redirectUrl,
    amountCents: payment.amount,
    currency: "ZAR",
    merchantReference: payment.merchantReference,
    status: payment.status,
  };
}

// ------------------------------------------------------------
// RETRIEVE PAYMENT DETAILS
// ------------------------------------------------------------

export async function getStitchPayment(paymentId) {
  if (
    typeof paymentId !== "string" ||
    !paymentId.trim() ||
    paymentId.length > 200
  ) {
    throw new Error("Invalid Stitch payment ID.");
  }

  const result = await stitchRequest(
    `/payment/${encodeURIComponent(paymentId)}`
  );

  const payment = result?.data?.payment;

  if (!payment || payment.id !== paymentId) {
    throw new Error(
      "Stitch payment verification returned invalid details."
    );
  }

  return payment;
}

// ------------------------------------------------------------
// RETRIEVE PAYMENT LINK DETAILS
// ------------------------------------------------------------

export async function getStitchPaymentLink(paymentLinkId) {
  if (
    typeof paymentLinkId !== "string" ||
    !paymentLinkId.trim() ||
    paymentLinkId.length > 200
  ) {
    throw new Error("Invalid Stitch payment-link ID.");
  }

  const result = await stitchRequest(
    `/payment-links/${encodeURIComponent(paymentLinkId)}`
  );

  const payment = result?.data?.payment;

  if (!payment || payment.id !== paymentLinkId) {
    throw new Error(
      "Stitch returned invalid payment-link details."
    );
  }

  return payment;
}
