
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const PAYFAST_URLS = Object.freeze({
  live: "https://www.payfast.co.za/eng/process",
  sandbox: "https://sandbox.payfast.co.za/eng/process",
});

function requiredEnv(name) {
  const value = process.env[name];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing.`);
  }

  return value.trim();
}

function validateUrl(value, name, mode) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (
    parsed.protocol !== "https:" &&
    !(
      mode === "sandbox" &&
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
  ) {
    throw new Error(`${name} must use HTTPS.`);
  }

  return parsed.toString();
}

function getPayfastConfig() {
  const mode = (
    process.env.PAYFAST_MODE || "sandbox"
  ).trim().toLowerCase();

  if (!Object.hasOwn(PAYFAST_URLS, mode)) {
    throw new Error("PAYFAST_MODE must be live or sandbox.");
  }

  const merchantId = requiredEnv("PAYFAST_MERCHANT_ID");
  const merchantKey = requiredEnv("PAYFAST_MERCHANT_KEY");
  const passphrase = requiredEnv("PAYFAST_PASSPHRASE");

  if (!/^\d{8}$/.test(merchantId)) {
    throw new Error("PAYFAST_MERCHANT_ID must contain 8 digits.");
  }

  return {
    mode,
    merchantId,
    merchantKey,
    passphrase,
    returnUrl: validateUrl(
      requiredEnv("PAYFAST_RETURN_URL"),
      "PAYFAST_RETURN_URL",
      mode
    ),
    cancelUrl: validateUrl(
      requiredEnv("PAYFAST_CANCEL_URL"),
      "PAYFAST_CANCEL_URL",
      mode
    ),
    notifyUrl: validateUrl(
      requiredEnv("PAYFAST_NOTIFY_URL"),
      "PAYFAST_NOTIFY_URL",
      mode
    ),
    processUrl: PAYFAST_URLS[mode],
  };
}

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
      value === undefined ||
      value === null ||
      String(value).trim() === ""
    ) {
      continue;
    }

    parameters.push(`${key}=${encodeValue(value)}`);
  }

  parameters.push(`passphrase=${encodeValue(passphrase)}`);

  return crypto
    .createHash("md5")
    .update(parameters.join("&"), "utf8")
    .digest("hex");
}

export async function initializePayfastTransaction({
  email,
  amount,
  reference,
  metadata = {},
}) {
  // Validate the reference before reading payment credentials.
  if (
    typeof reference !== "string" ||
    !/^SALIVE-[A-F0-9]{32}$/.test(reference)
  ) {
    throw new Error(
      `Invalid payment reference format. Received type: ${typeof reference}.`
    );
  }

  const config = getPayfastConfig();
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 5 ||
    Math.round(numericAmount * 100) !== numericAmount * 100
  ) {
    throw new Error(
      "Payment amount must be at least R5.00 with no more than two decimal places."
    );
  }

  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new Error("A valid customer email address is required.");
  }

  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error("Payment metadata must be an object.");
  }

  const fields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: config.returnUrl,
    cancel_url: config.cancelUrl,
    notify_url: config.notifyUrl,
    email_address: email.trim().toLowerCase(),
    m_payment_id: reference,
    amount: numericAmount.toFixed(2),
    item_name: "SA LIVE Call Minutes",
    item_description: `SA LIVE call time top-up: ${numericAmount.toFixed(2)} ZAR`,
  };

  for (const key of [
    "custom_str1",
    "custom_str2",
    "custom_str3",
    "custom_str4",
    "custom_str5",
  ]) {
    const value = metadata[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value !== "string" || value.length > 255) {
      throw new Error(`Invalid PayFast metadata field: ${key}.`);
    }

    fields[key] = value;
  }

  fields.signature = generateSignature(
    fields,
    config.passphrase
  );

  return {
    provider: "payfast",
    mode: config.mode,
    paymentUrl: config.processUrl,
    reference,
    fields,
  };
}
