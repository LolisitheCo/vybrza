
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

// ============================================================
// PAYFAST LIVE CONFIGURATION — SANDBOX DISABLED
// ============================================================

const PAYFAST_PROCESS_URL =
  "https://www.payfast.co.za/eng/process";

const PAYMENT_REFERENCE_PATTERN =
  /^SALIVE-[A-F0-9]{32}$/;

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function requiredEnv(name) {
  const value = process.env[name];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing.`);
  }

  return value.trim();
}

function validateHttpsUrl(value, name) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }

  return parsed.toString();
}

// ============================================================
// PAYFAST LIVE CONFIGURATION
// ============================================================

function getPayfastConfig() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (mode !== "live") {
    throw new Error(
      "SA LIVE requires PAYFAST_MODE=live. Sandbox is disabled."
    );
  }

  const merchantId = requiredEnv("PAYFAST_MERCHANT_ID");
  const merchantKey = requiredEnv("PAYFAST_MERCHANT_KEY");
  const passphrase = requiredEnv("PAYFAST_PASSPHRASE");

  if (!/^\d{8}$/.test(merchantId)) {
    throw new Error(
      "PAYFAST_MERCHANT_ID must contain exactly 8 digits."
    );
  }

  return {
    merchantId,
    merchantKey,
    passphrase,

    returnUrl: validateHttpsUrl(
      requiredEnv("PAYFAST_RETURN_URL"),
      "PAYFAST_RETURN_URL"
    ),

    cancelUrl: validateHttpsUrl(
      requiredEnv("PAYFAST_CANCEL_URL"),
      "PAYFAST_CANCEL_URL"
    ),

    notifyUrl: validateHttpsUrl(
      requiredEnv("PAYFAST_NOTIFY_URL"),
      "PAYFAST_NOTIFY_URL"
    ),
  };
}

// ============================================================
// PAYFAST SIGNATURE GENERATION
// ============================================================

function encodeValue(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (character) =>
      "%" +
      character.charCodeAt(0).toString(16).toUpperCase()
    );
}

function generateSignature(fields, passphrase) {
  const parameters = [];

  for (const [key, value] of Object.entries(fields)) {
    if (
      key === "signature" ||
      value === undefined ||
      value === null ||
      String(value).trim() === ""
    ) {
      continue;
    }

    parameters.push(`${key}=${encodeValue(value)}`);
  }

  parameters.push(
    `passphrase=${encodeValue(passphrase)}`
  );

  return createHash("md5")
    .update(parameters.join("&"), "utf8")
    .digest("hex");
}

// ============================================================
// INITIALIZE PAYFAST LIVE CHECKOUT
// ============================================================

export async function initializePayfastTransaction({
  email,
  amount,
  reference,
  metadata = {},
}) {
  // Validate payment reference
  if (
    typeof reference !== "string" ||
    !PAYMENT_REFERENCE_PATTERN.test(reference)
  ) {
    throw new Error(
      "Invalid payment reference. Expected SALIVE- followed by 32 uppercase hexadecimal characters."
    );
  }

  // Validate customer email
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    email !== email.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error(
      "A valid customer email address is required."
    );
  }

  // Validate payment amount
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 5 ||
    Math.abs(
      numericAmount * 100 -
      Math.round(numericAmount * 100)
    ) > 1e-8
  ) {
    throw new Error(
      "Payment amount must be at least R5.00 with no more than two decimal places."
    );
  }

  // Validate metadata
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      "Payment metadata must be an object."
    );
  }

  const config = getPayfastConfig();
  const formattedAmount = numericAmount.toFixed(2);

  const fields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: config.returnUrl,
    cancel_url: config.cancelUrl,
    notify_url: config.notifyUrl,
    email_address: email.toLowerCase(),
    m_payment_id: reference,
    amount: formattedAmount,
    item_name: "SA LIVE Call Minutes",
    item_description:
      `SA LIVE call time top-up: R${formattedAmount}`,
  };

  // Add supported custom metadata fields
  const metadataKeys = [
    "custom_str1",
    "custom_str2",
    "custom_str3",
    "custom_str4",
    "custom_str5",
  ];

  for (const key of metadataKeys) {
    const value = metadata[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (
      typeof value !== "string" ||
      value.length > 255
    ) {
      throw new Error(
        `Invalid PayFast metadata field: ${key}.`
      );
    }

    fields[key] = value;
  }

  // Generate payment signature
  fields.signature = generateSignature(
    fields,
    config.passphrase
  );

  return {
    provider: "payfast",
    mode: "live",
    paymentUrl: PAYFAST_PROCESS_URL,
    reference,
    fields,
  };
}
