
// ============================================================
// SA LIVE — STITCH DEVELOPER PORTAL SERVICE
// Pay By Bank + all payment methods enabled for this client
// ============================================================

const STITCH_TOKEN_URL =
  "https://secure.stitch.money/connect/token";

const STITCH_GRAPHQL_URL =
  "https://api.stitch.money/graphql";

let cachedAccessToken = null;
let tokenExpiresAt = 0;

// ============================================================
// CONFIGURATION
// ============================================================

function getStitchConfig() {
  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;
  const redirectUrl = process.env.STITCH_REDIRECT_URL;

  if (!clientId || !clientSecret || !redirectUrl) {
    throw new Error(
      "Missing Stitch configuration. Check STITCH_CLIENT_ID, STITCH_CLIENT_SECRET and STITCH_REDIRECT_URL."
    );
  }

  let parsedRedirectUrl;

  try {
    parsedRedirectUrl = new URL(redirectUrl);
  } catch {
    throw new Error("STITCH_REDIRECT_URL is not a valid URL.");
  }

  if (parsedRedirectUrl.protocol !== "https:") {
    throw new Error("STITCH_REDIRECT_URL must use HTTPS.");
  }

  return {
    clientId,
    clientSecret,
    redirectUrl: parsedRedirectUrl.toString(),
  };
}

// ============================================================
// ACCESS TOKEN
// ============================================================

async function getStitchAccessToken() {
  const { clientId, clientSecret } = getStitchConfig();

  if (
    cachedAccessToken &&
    Date.now() < tokenExpiresAt
  ) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "client_paymentrequest",
    audience: STITCH_TOKEN_URL,
  });

  const response = await fetch(STITCH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    console.error("Stitch authentication failed:", {
      status: response.status,
      error: result.error,
      description: result.error_description,
    });

    throw new Error(
      "Could not authenticate with Stitch Developer Portal."
    );
  }

  cachedAccessToken = result.access_token;

  const expiresIn = Number(result.expires_in || 3600);

  tokenExpiresAt =
    Date.now() +
    Math.max(expiresIn - 60, 60) * 1000;

  return cachedAccessToken;
}

// ============================================================
// GRAPHQL CLIENT
// ============================================================

async function stitchGraphQL(query, variables = {}) {
  const token = await getStitchAccessToken();

  const response = await fetch(STITCH_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.errors?.length || !result.data) {
    console.error("Stitch GraphQL request failed:", {
      status: response.status,
      errors: result.errors,
    });

    throw new Error(
      result.errors?.[0]?.message ||
      "Stitch payment request failed."
    );
  }

  return result.data;
}

// ============================================================
// CREATE PAYMENT REQUEST
// ============================================================

export async function createStitchPaymentRequest({
  reference,
  amount,
  userId,
}) {
  if (!reference || !userId) {
    throw new Error(
      "Payment reference and customer ID are required."
    );
  }

  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 1
  ) {
    throw new Error("Invalid payment amount.");
  }

  const { redirectUrl } = getStitchConfig();

  // Keep bank-statement references within Stitch limits.
  const shortReference = reference.replace(
    /[^A-Za-z0-9]/g,
    ""
  );

  const payerReference =
    `SALIVE${shortReference.slice(-6)}`.slice(0, 12);

  const beneficiaryReference =
    `SALIVE-${shortReference.slice(-12)}`.slice(0, 20);

  const mutation = `
    mutation CreatePaymentRequest(
      $input: ClientPaymentInitiationRequestCreateInput!
    ) {
      clientPaymentInitiationRequestCreate(input: $input) {
        paymentInitiationRequest {
          id
          url
        }
      }
    }
  `;

  const expireAt = new Date(
    Date.now() + 30 * 60 * 1000
  ).toISOString();

  const input = {
    amount: {
      quantity: numericAmount.toFixed(2),
      currency: "ZAR",
    },

    payerReference,

    beneficiaryReference,

    // Full internal SA LIVE payment reference.
    externalReference: reference,

    expireAt,

    payerInformation: {
      payerId: String(userId),
    },

    // Do not disable payment methods.
    // Stitch will use the methods available to this client.

    metadata: {
      application: "SA LIVE",
      paymentReference: reference,
    },
  };

  const data = await stitchGraphQL(
    mutation,
    { input }
  );

  const paymentRequest =
    data.clientPaymentInitiationRequestCreate
      ?.paymentInitiationRequest;

  if (
    !paymentRequest?.id ||
    !paymentRequest?.url
  ) {
    console.error(
      "Unexpected Stitch payment request response:",
      data
    );

    throw new Error(
      "Stitch did not return a valid payment request."
    );
  }

  let checkoutUrl;

  try {
    checkoutUrl = new URL(paymentRequest.url);
  } catch {
    throw new Error(
      "Stitch returned an invalid checkout URL."
    );
  }

  if (checkoutUrl.protocol !== "https:") {
    throw new Error(
      "Stitch checkout URL must use HTTPS."
    );
  }

  // Stitch requires the redirect URL to be allowlisted.
  checkoutUrl.searchParams.set(
    "redirect_uri",
    redirectUrl
  );

  return {
    paymentRequestId: paymentRequest.id,
    redirectUrl: checkoutUrl.toString(),
    stitchUrl: paymentRequest.url,
  };
}

// ============================================================
// GET PAYMENT REQUEST STATUS
// ============================================================

export async function getStitchPaymentRequest(
  paymentRequestId
) {
  if (!paymentRequestId) {
    throw new Error(
      "Stitch payment request ID is required."
    );
  }

  const query = `
    query GetPaymentRequest($paymentRequestId: ID!) {
      node(id: $paymentRequestId) {
        ... on PaymentInitiationRequest {
          id

          externalReference

          amount {
            quantity
            currency
          }

          state {
            __typename

            ... on PaymentInitiationRequestCompleted {
              date

              amount {
                quantity
                currency
              }
            }

            ... on PaymentInitiationRequestCancelled {
              reason
            }

            ... on PaymentInitiationRequestExpired {
              __typename
            }

            ... on PaymentInitiationRequestPending {
              __typename
            }
          }
        }
      }
    }
  `;

  const data = await stitchGraphQL(
    query,
    { paymentRequestId }
  );

  if (!data.node) {
    throw new Error(
      "Stitch payment request was not found."
    );
  }

  return data.node;
}

// ============================================================
// CLEAR TOKEN CACHE
// Useful for controlled re-authentication.
// ============================================================

export function clearStitchTokenCache() {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}
