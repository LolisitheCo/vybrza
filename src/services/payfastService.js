
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

// ============================================================
// SA LIVE — PAYFAST CONFIGURATION
// ============================================================

const DEFAULT_PAYFAST_PAYMENT_URL =
  "https://www.payfast.co.za/eng/process";

const PAYMENT_REFERENCE_PATTERN =
  /^SALIVE-[A-F0-9]{32}$/;

const EMAIL_PATTERN =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LENGTH = 254;
const MINIMUM_PAYMENT_AMOUNT = 5;

const METADATA_KEYS = [
  "custom_str1",
  "custom_str2",
  "custom_str3",
  "custom_str4",
  "custom_str5",
];

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function requiredEnv(name) {
  const value = process.env[name];

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(`${name} is missing.`);
  }

  return value.trim();
}

function validateHttpsUrl(value, name) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${name} must be a valid absolute URL.`
    );
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `${name} must be a valid HTTPS URL without embedded credentials.`
    );
  }

  return parsed.toString();
}

function validatePayfastCheckoutUrl(value) {
  const parsed = validateHttpsUrl(
    value,
    "PAYFAST_PAYMENT_URL"
  );

  const url = new URL(parsed);

  if (
    url.hostname !== "www.payfast.co.za" ||
    url.pathname !== "/eng/process" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PAYFAST_PAYMENT_URL must be https://www.payfast.co.za/eng/process."
    );
  }

  return url.toString();
}

function getPayfastConfig() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (mode !== "live") {
    throw new Error(
      "SA LIVE requires PAYFAST_MODE=live. Sandbox is disabled."
    );
  }

  const merchantId = requiredEnv(
    "PAYFAST_MERCHANT_ID"
  );

  const merchantKey = requiredEnv(
    "PAYFAST_MERCHANT_KEY"
  );

  const passphrase = requiredEnv(
    "PAYFAST_PASSPHRASE"
  );

  if (!/^\d{8}$/.test(merchantId)) {
    throw new Error(
      "PAYFAST_MERCHANT_ID must contain exactly 8 digits."
    );
  }

  if (passphrase.length > 32) {
    throw new Error(
      "PAYFAST_PASSPHRASE must not exceed 32 characters."
    );
  }

  const paymentUrl = validatePayfastCheckoutUrl(
    (
      process.env.PAYFAST_PAYMENT_URL ||
      DEFAULT_PAYFAST_PAYMENT_URL
    ).trim()
  );

  return {
    merchantId,
    merchantKey,
    passphrase,
    paymentUrl,

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
// PAYFAST SIGNATURE HELPERS
// ============================================================

function encodeValue(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (character) =>
      `%${character
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()}`
    );
}

function generateSignature(fields, passphrase) {
  const parameters = [];

  // Preserve the order in which PayFast fields are created.
  // Do not alphabetically sort custom checkout signatures.
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === "signature" ||
      value === undefined ||
      value === null ||
      String(value).trim() === ""
    ) {
      continue;
    }

    parameters.push(
      `${key}=${encodeValue(value)}`
    );
  }

  parameters.push(
    `passphrase=${encodeValue(passphrase)}`
  );

  return createHash("md5")
    .update(parameters.join("&"), "utf8")
    .digest("hex");
}

// ============================================================
// INITIALIZE PAYFAST TRANSACTION
// ============================================================

export async function initializePayfastTransaction(
  options = {}
) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new Error(
      "PayFast transaction options must be an object."
    );
  }

  const {
    email,
    amount,
    reference,
    metadata = {},
  } = options;

  // Payment reference
  if (
    typeof reference !== "string" ||
    !PAYMENT_REFERENCE_PATTERN.test(reference)
  ) {
    throw new Error(
      "Invalid payment reference. Expected SALIVE- followed by 32 uppercase hexadecimal characters."
    );
  }

  // Customer email
  if (
    typeof email !== "string" ||
    email.length > MAX_EMAIL_LENGTH ||
    email !== email.trim() ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error(
      "A valid customer email address is required."
    );
  }

  // Payment amount
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < MINIMUM_PAYMENT_AMOUNT ||
    Math.abs(
      numericAmount * 100 -
      Math.round(numericAmount * 100)
    ) > 1e-8
  ) {
    throw new Error(
      "Payment amount must be at least R5.00 with no more than two decimal places."
    );
  }

  // Metadata
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      "Payment metadata must be an object."
    );
  }

  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.includes(key)) {
      throw new Error(
        `Unsupported PayFast metadata field: ${key}.`
      );
    }
  }

  const config = getPayfastConfig();
  const formattedAmount = numericAmount.toFixed(2);

  // Keep checkout field insertion order consistent.
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

  for (const key of METADATA_KEYS) {
    const value = metadata[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (
      typeof value !== "string" ||
      value.length > 255 ||
      /[\u0000-\u001F\u007F]/.test(value)
    ) {
      throw new Error(
        `Invalid PayFast metadata field: ${key}.`
      );
    }

    fields[key] = value;
  }

  // Generate the signature on the backend only.
  fields.signature = generateSignature(
    fields,
    config.passphrase
  );

  return {
    provider: "payfast",
    mode: "live",
    paymentUrl: config.paymentUrl,
    reference,
    fields,
  };
}
