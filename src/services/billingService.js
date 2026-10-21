
import { db } from "../config/firebase.js";

// ============================================================
// SA LIVE BILLING SERVICE
// ============================================================
// Customer: R6 per billable minute
// Host:     R2 per billable minute
// SA LIVE:  R4 per billable minute
//
// IMPORTANT:
// Call this service only from trusted backend code after
// endCall() has completed. Never expose it as an unrestricted
// public endpoint.
// ============================================================

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callsCollection = db.collection("callSessions");
const earningsCollection = db.collection("hostEarnings");

export const SA_LIVE_PRICING = Object.freeze({
  customerPricePerMinute: 6,
  hostEarningsPerMinute: 2,
  saLiveRevenuePerMinute: 4,
});

const MAX_MINUTES = Number.MAX_SAFE_INTEGER;

// ============================================================
// HELPERS
// ============================================================

function requireId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    value.includes("/") ||
    value.includes("\0")
  ) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return value.trim();
}

function readMinutes(value, fieldName) {
  const minutes = value ?? 0;

  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 0
  ) {
    throw new Error(`${fieldName} balance is invalid.`);
  }

  return minutes;
}

function readCents(value, fieldName) {
  const cents = value ?? 0;

  if (
    !Number.isSafeInteger(cents) ||
    cents < 0
  ) {
    throw new Error(`${fieldName} balance is invalid.`);
  }

  return cents;
}

function moneyToCents(rand) {
  const cents = rand * 100;

  if (!Number.isSafeInteger(cents)) {
    throw new Error("Calculated billing amount is invalid.");
  }

  return cents;
}

// ============================================================
// FINALIZE CALL BILLING
// ============================================================
// callId must identify an existing completed call.
//
// The customer's balance is charged no more than their available
// minutes. Host earnings and SA LIVE revenue use the minutes
// actually charged.
//
// Repeated calls do not charge the customer again.
// ============================================================

export async function finalizeCallBilling(callId) {
  callId = requireId(callId, "Call ID");

  const callRef = callsCollection.doc(callId);

  return db.runTransaction(async (transaction) => {
    // 1. Read call.
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      throw new Error("Call session was not found.");
    }

    const call = callSnapshot.data();

    // Idempotency: never charge a finalized call twice.
    if (call.billingStatus === "finalized") {
      return {
        success: true,
        alreadyFinalized: true,
        callId,
        billableMinutes: call.billableMinutes ?? 0,
        customerCharged:
          (call.customerChargeCents ?? 0) / 100,
        hostEarnings:
          (call.hostEarningsCents ?? 0) / 100,
        saLiveRevenue:
          (call.saLiveRevenueCents ?? 0) / 100,
      };
    }

    if (call.status !== "completed") {
      throw new Error(
        "Only completed calls can be billed."
      );
    }

    if (call.billingStatus !== "pending") {
      throw new Error(
        "Call billing is not in a billable state."
      );
    }

    const userId = requireId(call.userId, "User ID");
    const hostId = requireId(call.hostId, "Host ID");

    // Prefer the duration saved by endCall().
    // Round up partial minutes for billing.
    const durationSeconds = call.durationSeconds ?? 0;

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw new Error("Call duration is invalid.");
    }

    const calculatedMinutes = Math.ceil(
      durationSeconds / 60
    );

    if (
      calculatedMinutes > MAX_MINUTES ||
      !Number.isSafeInteger(calculatedMinutes)
    ) {
      throw new Error("Call duration is too large.");
    }

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);
    const earningRef = earningsCollection.doc(callId);

    // 2. Read all remaining documents before writing.
    const [
      userSnapshot,
      hostSnapshot,
      earningSnapshot,
    ] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
      transaction.get(earningRef),
    ]);

    if (!userSnapshot.exists) {
      throw new Error("Customer account was not found.");
    }

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    // A pre-existing earnings record with pending billing
    // indicates inconsistent data. Do not silently credit again.
    if (earningSnapshot.exists) {
      throw new Error(
        "Host earnings already exist for an unfinalized call. Review this call before retrying."
      );
    }

    const availableMinutes = readMinutes(
      userSnapshot.get("minutes"),
      "Customer"
    );

    // Never allow the customer's minute balance to go negative.
    const billableMinutes = Math.min(
      calculatedMinutes,
      availableMinutes
    );

    const customerChargeCents = moneyToCents(
      billableMinutes *
        SA_LIVE_PRICING.customerPricePerMinute
    );

    const hostEarningsCents = moneyToCents(
      billableMinutes *
        SA_LIVE_PRICING.hostEarningsPerMinute
    );

    const saLiveRevenueCents = moneyToCents(
      billableMinutes *
        SA_LIVE_PRICING.saLiveRevenuePerMinute
    );

    const host = hostSnapshot.data();

    const currentAvailableCents = readCents(
      host.availableHostEarningsCents,
      "Available host earnings"
    );

    const currentLifetimeCents = readCents(
      host.lifetimeHostEarningsCents,
      "Lifetime host earnings"
    );

    const newAvailableCents =
      currentAvailableCents + hostEarningsCents;

    const newLifetimeCents =
      currentLifetimeCents + hostEarningsCents;

    if (
      !Number.isSafeInteger(newAvailableCents) ||
      !Number.isSafeInteger(newLifetimeCents)
    ) {
      throw new Error("Host earnings balance is too large.");
    }

    const now = new Date();

    // 3. Atomically update customer, host, call and earnings.
    transaction.update(userRef, {
      minutes: availableMinutes - billableMinutes,
      updatedAt: now,
    });

    transaction.update(hostRef, {
      availableHostEarningsCents: newAvailableCents,
      lifetimeHostEarningsCents: newLifetimeCents,
      updatedAt: now,
    });

    transaction.update(callRef, {
      billingStatus: "finalized",
      billableMinutes,
      customerChargeCents,
      hostEarningsCents,
      saLiveRevenueCents,
      hostEarnings: hostEarningsCents / 100,
      billedAt: now,
      updatedAt: now,
    });

    // Only create an earnings record when the host has
    // billable minutes to earn from.
    if (billableMinutes > 0) {
      transaction.create(earningRef, {
        callId,
        userId,
        hostId,
        completedMinutes: billableMinutes,
        ratePerMinute:
          SA_LIVE_PRICING.hostEarningsPerMinute,
        amount: hostEarningsCents / 100,
        amountCents: hostEarningsCents,
        currency: "ZAR",
        status: "available",
        createdAt: now,
      });
    }

    return {
      success: true,
      alreadyFinalized: false,
      callId,
      billableMinutes,
      customerCharged: customerChargeCents / 100,
      hostEarnings: hostEarningsCents / 100,
      saLiveRevenue: saLiveRevenueCents / 100,
      remainingCustomerMinutes:
        availableMinutes - billableMinutes,
    };
  });
}

// ============================================================
// GET CALL BILLING SUMMARY
// ============================================================

export async function getCallBillingSummary(callId) {
  callId = requireId(callId, "Call ID");

  const snapshot = await callsCollection
    .doc(callId)
    .get();

  if (!snapshot.exists) {
    throw new Error("Call session was not found.");
  }

  const call = snapshot.data();

  return {
    callId,
    status: call.status,
    billingStatus: call.billingStatus,
    billableMinutes: call.billableMinutes ?? 0,
    customerCharged:
      (call.customerChargeCents ?? 0) / 100,
    hostEarnings:
      (call.hostEarningsCents ?? 0) / 100,
    saLiveRevenue:
      (call.saLiveRevenueCents ?? 0) / 100,
    currency: "ZAR",
  };
}
