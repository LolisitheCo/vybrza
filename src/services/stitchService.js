import "dotenv/config";

const STITCH_BASE_URL = "https://express.stitch.money/api/v1";

let cachedAccessToken = null;
let tokenExpiresAt = 0;

function getCredentials() {
  const clientId = process.env.STITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.STITCH_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Stitch Express credentials are missing.");
  }

  return { clientId, clientSecret };
}

async function readResponse(response) {
  const text = await response.text();

  let body = {};

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Stitch returned an invalid response.");
    }
  }

  if (!response.ok || body.success === false) {
    const message =
      body.generalErrors?.join(", ") ||
      body.message ||
      `Stitch API request failed (${response.status}).`;

    throw new Error(message);
  }

  return body;
}

export async function getStitchAccessToken(forceRefresh = false) {
  if (
    !forceRefresh &&
    cachedAccessToken &&
    Date.now() < tokenExpiresAt
  ) {
    return cachedAccessToken;
  }

  const { clientId, clientSecret } = getCredentials();

  const response = await fetch(`${STITCH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      scope: "client_paymentrequest",
    }),
  });

  const result = await readResponse(response);
  const accessToken = result?.data?.accessToken;

  if (
    typeof accessToken !== "string" ||
    !accessToken.trim()
  ) {
    throw new Error("Stitch did not return an access token.");
  }

  cachedAccessToken = accessToken;

  // Stitch tokens expire after 15 minutes.
  // Refresh slightly early to avoid using an expiring token.
  tokenExpiresAt = Date.now() + 14 * 60 * 1000;

  return cachedAccessToken;
}

async function stitchRequest(path, options = {}, retry = true) {
  const token = await getStitchAccessToken();

  const response = await fetch(`${STITCH_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  if (response.status === 401 && retry) {
    cachedAccessToken = null;
    tokenExpiresAt = 0;

    await getStitchAccessToken(true);

    return stitchRequest(path, options, false);
  }

  return readResponse(response);
}

export async function createStitchPaymentLink({
  amount,
  payerName,
  payerEmailAddress,
  merchantReference,
}) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 100
  ) {
    throw new Error(
      "Stitch payment amount must be at least 100 cents."
    );
  }

  if (
    typeof payerName !== "string" ||
    payerName.trim().length < 3 ||
    payerName.trim().length > 40
  ) {
    throw new Error("Invalid Stitch payer name.");
  }

  if (
    typeof merchantReference !== "string" ||
    !/^[a-zA-Z0-9\s\-()]+$/.test(merchantReference) ||
    merchantReference.length > 50
  ) {
    throw new Error("Invalid Stitch merchant reference.");
  }

  const body = {
    amount,
    payerName: payerName.trim(),
    merchantReference,
  };

  if (payerEmailAddress) {
    body.payerEmailAddress = payerEmailAddress;
  }

  const result = await stitchRequest("/payment-links", {
    method: "POST",
    body,
  });

  const payment = result?.data?.payment;

  if (
    !payment ||
    typeof payment.id !== "string" ||
    typeof payment.link !== "string" ||
    payment.amount !== amount ||
    payment.merchantReference !== merchantReference
  ) {
    throw new Error(
      "Stitch returned an invalid payment link."
    );
  }

  return payment;
}

export async function getStitchPaymentLink(paymentLinkId) {
  if (
    typeof paymentLinkId !== "string" ||
    !paymentLinkId.trim()
  ) {
    throw new Error("Invalid Stitch payment link ID.");
  }

  const result = await stitchRequest(
    `/payment-links/${encodeURIComponent(paymentLinkId)}`
  );

  const payment = result?.data?.payment;

  if (!payment || typeof payment.id !== "string") {
    throw new Error(
      "Stitch did not return the requested payment link."
    );
  }

  return payment;
}

export async function getStitchPayment(paymentId) {
  if (
    typeof paymentId !== "string" ||
    !paymentId.trim()
  ) {
    throw new Error("Invalid Stitch payment ID.");
  }

  const result = await stitchRequest(
    `/payment/${encodeURIComponent(paymentId)}`
  );

  const payment = result?.data?.payment;

  if (!payment || typeof payment.id !== "string") {
    throw new Error(
      "Stitch did not return the requested payment."
    );
  }

  return payment;
}