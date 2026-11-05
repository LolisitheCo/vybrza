// ============================================================
// SA LIVE — YOCO CHECKOUT API
// All calls are server-side. Never expose YOCO_SECRET_KEY to Vite.
// ============================================================

const YOCO_API_URL = "https://payments.yoco.com/api/checkouts";
const ALLOWED_REDIRECT_HOSTS = new Set(["c.yoco.com"]);

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is not configured.`);
  }
  return value.trim();
}

function getFrontendBaseUrl() {
  const configured = requiredEnv("FRONTEND_URL");
  const url = new URL(configured);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("FRONTEND_URL must use HTTPS in production.");
  }
  return url.origin;
}

export async function createYocoCheckout({
  reference,
  amountCents,
  packageId,
  packageName,
  userId,
}) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 200) {
    throw new Error("Yoco amount must be at least R2.00 and supplied in cents.");
  }
  if (typeof reference !== "string" || !/^SALIVE-[A-F0-9]{32}$/.test(reference)) {
    throw new Error("Payment reference is invalid.");
  }

  const secretKey = requiredEnv("YOCO_SECRET_KEY");
  if (!/^(sk_test_|sk_live_)/.test(secretKey)) {
    throw new Error("YOCO_SECRET_KEY must be a Yoco secret key.");
  }

  const frontendBase = getFrontendBaseUrl();
  const referenceParam = encodeURIComponent(reference);
  const payload = {
    amount: amountCents,
    currency: "ZAR",
    successUrl: `${frontendBase}/payment/result?reference=${referenceParam}`,
    cancelUrl: `${frontendBase}/user?payment=cancelled&reference=${referenceParam}`,
    failureUrl: `${frontendBase}/user?payment=failed&reference=${referenceParam}`,
    clientReferenceId: reference,
    externalId: reference,
    metadata: {
      reference,
      packageId: String(packageId),
      userId: String(userId),
      packageName: String(packageName).slice(0, 100),
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(YOCO_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": reference,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const safeMessage = typeof result?.message === "string"
        ? result.message.slice(0, 240)
        : `Yoco checkout request failed (HTTP ${response.status}).`;
      throw new Error(safeMessage);
    }

    if (
      typeof result?.id !== "string" ||
      typeof result?.redirectUrl !== "string" ||
      !Number.isSafeInteger(result?.amount) ||
      result.amount !== amountCents ||
      result.currency !== "ZAR"
    ) {
      throw new Error("Yoco returned incomplete or mismatched checkout details.");
    }

    const redirectUrl = new URL(result.redirectUrl);
    if (
      redirectUrl.protocol !== "https:" ||
      !ALLOWED_REDIRECT_HOSTS.has(redirectUrl.hostname) ||
      redirectUrl.username ||
      redirectUrl.password
    ) {
      throw new Error("Yoco returned an untrusted checkout URL.");
    }

    const processingMode = result.processingMode;
    if (!new Set(["test", "live"]).has(processingMode)) {
      throw new Error("Yoco returned an unknown processing mode.");
    }

    return {
      checkoutId: result.id,
      redirectUrl: redirectUrl.toString(),
      amountCents: result.amount,
      currency: result.currency,
      processingMode,
    };
  } finally {
    clearTimeout(timeout);
  }
}
