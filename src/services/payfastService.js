import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

/*
|--------------------------------------------------------------------------
| PAYFAST CONFIGURATION
|--------------------------------------------------------------------------
| Live checkout is the default.
|
| Environment variables:
| PAYFAST_MODE=live
| PAYFAST_MERCHANT_ID=your_live_merchant_id
| PAYFAST_MERCHANT_KEY=your_live_merchant_key
| PAYFAST_PASSPHRASE=your_live_passphrase
| PAYFAST_RETURN_URL=https://your-domain/...
| PAYFAST_CANCEL_URL=https://your-domain/...
| PAYFAST_NOTIFY_URL=https://your-domain/...
|
| To explicitly use PayFast sandbox during development:
| PAYFAST_MODE=sandbox
|--------------------------------------------------------------------------
*/

const PAYFAST_URLS = {
  live: "https://www.payfast.co.za/eng/process",
  sandbox: "https://sandbox.payfast.co.za/eng/process",
};

/*
|--------------------------------------------------------------------------
| GET CONFIGURATION
|--------------------------------------------------------------------------
*/

function getPayfastConfig() {
  const mode = (
    process.env.PAYFAST_MODE || "live"
  ).trim().toLowerCase();

  if (!Object.hasOwn(PAYFAST_URLS, mode)) {
    throw new Error(
      "PAYFAST_MODE must be either live or sandbox."
    );
  }

  const merchantId = (
    process.env.PAYFAST_MERCHANT_ID || ""
  ).trim();

  const merchantKey = (
    process.env.PAYFAST_MERCHANT_KEY || ""
  ).trim();

  const passphrase =
    process.env.PAYFAST_PASSPHRASE || "";

  if (!/^\d{8}$/.test(merchantId)) {
    throw new Error(
      "PAYFAST_MERCHANT_ID must be your 8-digit merchant ID."
    );
  }

  if (!merchantKey) {
    throw new Error(
      "PAYFAST_MERCHANT_KEY is missing."
    );
  }

  if (!passphrase.trim()) {
    throw new Error(
      "PAYFAST_PASSPHRASE is missing."
    );
  }

  const returnUrl = validateUrl(
    process.env.PAYFAST_RETURN_URL,
    "PAYFAST_RETURN_URL",
    mode
  );

  const cancelUrl = validateUrl(
    process.env.PAYFAST_CANCEL_URL,
    "PAYFAST_CANCEL_URL",
    mode
  );

  const notifyUrl = validateUrl(
    process.env.PAYFAST_NOTIFY_URL,
    "PAYFAST_NOTIFY_URL",
    mode
  );

  return {
    mode,
    merchantId,
    merchantKey,
    passphrase,
    returnUrl,
    cancelUrl,
    notifyUrl,
    processUrl: PAYFAST_URLS[mode],
  };
}

/*
|--------------------------------------------------------------------------
| VALIDATE URLS
|--------------------------------------------------------------------------
*/

function validateUrl(value, variableName, mode) {
  if (!value || typeof value !== "string") {
    throw new Error(
      `${variableName} is missing.`
    );
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${variableName} must be a valid absolute URL.`
    );
  }

  if (
    parsed.protocol !== "https:" &&
    !(
      mode === "sandbox" &&
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(
        parsed.hostname
      )
    )
  ) {
    throw new Error(
      `${variableName} must use HTTPS.`
    );
  }

  if (
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `${variableName} must not contain URL credentials.`
    );
  }

  return parsed.toString();
}

/*
|--------------------------------------------------------------------------
| PAYFAST FORM URL ENCODING
|--------------------------------------------------------------------------
| PayFast's custom checkout signature uses URL-encoded field values.
| Spaces must be encoded as "+".
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| GENERATE CHECKOUT SIGNATURE
|--------------------------------------------------------------------------
| For the hosted custom integration, preserve the field order used
| to build the submitted form. Do not alphabetically sort these fields.
|--------------------------------------------------------------------------
*/

function generatePayfastSignature(
  fields,
  passphrase
) {
  const parameters = [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ""
    ) {
      continue;
    }

    parameters.push(
      `${key}=${payfastEncode(rawValue)}`
    );
  }

  parameters.push(
    `passphrase=${payfastEncode(passphrase)}`
  );

  const parameterString = parameters.join("&");

  return crypto
    .createHash("md5")
    .update(parameterString, "utf8")
    .digest("hex");
}

/*
|--------------------------------------------------------------------------
| INITIALIZE PAYFAST CHECKOUT
|--------------------------------------------------------------------------
| Returns the checkout URL and signed form fields.
|
| The controller must render a form or otherwise submit these fields
| to PayFast. Do not send the customer to the checkout URL without
| the corresponding form fields.
|
| amount is expressed in rand, e.g. 30 or 60.
| reference must match the pending payment document in Firestore.
|--------------------------------------------------------------------------
*/

export async function initializePayfastTransaction({
  email,
  amount,
  reference,
  metadata = {},
}) {
  const config = getPayfastConfig();

  if (
    typeof reference !== "string" ||
    reference.trim().length === 0 ||
    reference.trim().length > 100
  ) {
    throw new Error(
      "A valid payment reference is required."
    );
  }

  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 5 ||
    Math.round(numericAmount * 100) !==
      numericAmount * 100
  ) {
    throw new Error(
      "Payment amount must be at least R5.00 with no more than two decimal places."
    );
  }

  if (
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new Error(
      "A valid customer email address is required."
    );
  }

  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      "Payment metadata must be an object."
    );
  }

  /*
  |--------------------------------------------------------------------------
  | BUILD SIGNED FORM FIELDS
  |--------------------------------------------------------------------------
  | Never accept merchant credentials, payment amounts, package names,
  | or callback URLs directly from a browser or Telegram callback.
  |--------------------------------------------------------------------------
  */

  const fields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,

    return_url: config.returnUrl,
    cancel_url: config.cancelUrl,
    notify_url: config.notifyUrl,

    name_first: "",
    name_last: "",
    email_address: email.trim().toLowerCase(),

    m_payment_id: reference.trim(),

    amount: numericAmount.toFixed(2),

    item_name: "SA LIVE Call Minutes",
    item_description:
      `SA LIVE call time top-up: ${numericAmount.toFixed(2)} ZAR`,
  };

  /*
  |--------------------------------------------------------------------------
  | OPTIONAL NON-SENSITIVE METADATA
  |--------------------------------------------------------------------------
  | PayFast supports custom_str1 through custom_str5.
  | Keep values short and never place secrets or bank details here.
  |--------------------------------------------------------------------------
  */

  const allowedMetadataKeys = [
    "custom_str1",
    "custom_str2",
    "custom_str3",
    "custom_str4",
    "custom_str5",
  ];

  for (const key of allowedMetadataKeys) {
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

  fields.signature = generatePayfastSignature(
    fields,
    config.passphrase
  );

  return {
    provider: "payfast",
    mode: config.mode,
    paymentUrl: config.processUrl,
    reference: reference.trim(),
    fields,
  };
}