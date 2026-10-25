
import { db } from "../config/firebase.js";

// ============================================================
// SA LIVE BILLING SERVICE
// Customer: R6 per billable minute
// Host:     R2 per billable minute
// SA LIVE:  R4 per billable minute
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

const FINAL_BILLING_STATUS = "finalized";
const PENDING_BILLING_STATUS = "pending";

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function requireId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    value.trim().includes("/") ||
    value.includes("\0")
  ) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return value.trim();
}

function readMinutes(value, fieldName) {
  const minutes = value ?? 0;

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error(`${fieldName} balance is invalid.`);
  }

  return minutes;
}

function readCents(value, fieldName) {
  const cents = value ?? 0;

  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`${fieldName} balance is invalid.`);
  }

  return cents;
}

function moneyToCents(amount) {
  const cents = amount * 100;

  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Calculated billing amount is invalid.");
  }

  return cents;
}

function centsToMoney(cents) {
  return cents / 100;
}

function makeBillingResult(callId, call, alreadyFinalized) {
  return {
    success: true,
    alreadyFinalized,
    callId,
    billingStatus: call.billingStatus,
    billableMinutes: call.billableMinutes ?? 0,
    customerCharged: centsToMoney(
      call.customerChargeCents ?? 0
    ),
    hostEarnings: centsToMoney(
      call.hostEarningsCents ?? 0
    ),
    saLiveRevenue: centsToMoney(
      call.saLiveRevenueCents ?? 0
    ),
  };
}

/*
|--------------------------------------------------------------------------
| FINALIZE CALL BILLING
|--------------------------------------------------------------------------
| Only completed calls can be billed.
|
| The transaction atomically:
| - deducts available customer minutes;
| - credits host earnings;
| - creates one earnings record;
| - marks call billing as finalized.
|
| Repeated calls are safe: a finalized call is never charged again.
|--------------------------------------------------------------------------
*/

export async function finalizeCallBilling(callId) {
  const normalizedCallId = requireId(callId, "Call ID");
  const callRef = callsCollection.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    // Read the call first.
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      throw new Error("Call session was not found.");
    }

    const call = callSnapshot.data();

    // Idempotency: never deduct or credit a finalized call twice.
    if (call.billingStatus === FINAL_BILLING_STATUS) {
      return makeBillingResult(
        normalizedCallId,
        call,
        true
      );
    }

    if (call.status !== "completed") {
      throw new Error("Only completed calls can be billed.");
    }

    if (call.billingStatus !== PENDING_BILLING_STATUS) {
      throw new Error("Call billing is not in a billable state.");
    }

    const userId = requireId(call.userId, "User ID");
    const hostId = requireId(call.hostId, "Host ID");

    const durationSeconds = call.durationSeconds ?? 0;

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw new Error("Call duration is invalid.");
    }

    const calculatedMinutes = Math.ceil(durationSeconds / 60);

    if (!Number.isSafeInteger(calculatedMinutes)) {
      throw new Error("Call duration is too large.");
    }

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);
    const earningRef = earningsCollection.doc(normalizedCallId);

    // All reads must complete before any transaction writes.
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

    // An existing earning record alongside pending billing is
    // inconsistent data. Fail safely rather than crediting twice.
    if (earningSnapshot.exists) {
      throw new Error(
        "An earnings record already exists for this unfinalized call. Administrator review is required."
      );
    }

    const user = userSnapshot.data();
    const host = hostSnapshot.data();

    const availableMinutes = readMinutes(
      user.minutes,
      "Customer"
    );

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

    const billingFields = {
      billingStatus: FINAL_BILLING_STATUS,
      billableMinutes,
      customerChargeCents,
      hostEarningsCents,
      saLiveRevenueCents,
      customerCharge: centsToMoney(customerChargeCents),
      hostEarnings: centsToMoney(hostEarningsCents),
      saLiveRevenue: centsToMoney(saLiveRevenueCents),
      billedAt: now,
      updatedAt: now,
    };

    // All monetary changes and finalization occur atomically.
    transaction.update(userRef, {
      minutes: availableMinutes - billableMinutes,
      updatedAt: now,
    });

    transaction.update(hostRef, {
      availableHostEarningsCents: newAvailableCents,
      lifetimeHostEarningsCents: newLifetimeCents,
      updatedAt: now,
    });

    transaction.update(callRef, billingFields);

    // Keep a deterministic earnings document ID for idempotency.
    // Zero-minute calls have no payable earnings record.
    if (billableMinutes > 0) {
      transaction.create(earningRef, {
        callId: normalizedCallId,
        userId,
        hostId,
        completedMinutes: billableMinutes,
        ratePerMinute: SA_LIVE_PRICING.hostEarningsPerMinute,
        amount: centsToMoney(hostEarningsCents),
        amountCents: hostEarningsCents,
        currency: "ZAR",
        status: "available",
        createdAt: now,
      });
    }

    return {
      success: true,
      alreadyFinalized: false,
      callId: normalizedCallId,
      billingStatus: FINAL_BILLING_STATUS,
      billableMinutes,
      customerCharged: centsToMoney(customerChargeCents),
      hostEarnings: centsToMoney(hostEarningsCents),
      saLiveRevenue: centsToMoney(saLiveRevenueCents),
      remainingCustomerMinutes:
        availableMinutes - billableMinutes,
      insufficientMinutes:
        calculatedMinutes > availableMinutes,
    };
  });
}

/*
|--------------------------------------------------------------------------
| GET CALL BILLING SUMMARY
|--------------------------------------------------------------------------
*/

export async function getCallBillingSummary(callId) {
  const normalizedCallId = requireId(callId, "Call ID");

  const snapshot = await callsCollection
    .doc(normalizedCallId)
    .get();

  if (!snapshot.exists) {
    throw new Error("Call session was not found.");
  }

  const call = snapshot.data();

  return {
    callId: normalizedCallId,
    status: call.status,
    billingStatus: call.billingStatus,
    billableMinutes: call.billableMinutes ?? 0,
    customerCharged: centsToMoney(
      call.customerChargeCents ?? 0
    ),
    hostEarnings: centsToMoney(
      call.hostEarningsCents ?? 0
    ),
    saLiveRevenue: centsToMoney(
      call.saLiveRevenueCents ?? 0
    ),
    currency: "ZAR",
  };
}
