
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
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 150 ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw makeError(`${fieldName} is invalid.`, 400);
  }

  return value.trim();
}

function readMinutes(value, fieldName) {
  if (
    value === undefined ||
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw makeError(`${fieldName} balance is invalid.`, 409);
  }

  return value;
}

function readCents(value, fieldName) {
  if (
    value === undefined ||
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw makeError(`${fieldName} balance is invalid.`, 409);
  }

  return value;
}

function moneyToCents(amount) {
  const cents = amount * 100;

  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw makeError("Calculated billing amount is invalid.", 500);
  }

  return cents;
}

function centsToMoney(cents) {
  return cents / 100;
}

function toDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value.toDate === "function") {
    const date = value.toDate();

    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date
      : null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function makeBillingResult(callId, call, alreadyFinalized) {
  return {
    success: true,
    alreadyFinalized,
    callId,
    billingStatus: call.billingStatus,
    billableMinutes: call.billableMinutes ?? 0,
    customerCharged: centsToMoney(call.customerChargeCents ?? 0),
    hostEarnings: centsToMoney(call.hostEarningsCents ?? 0),
    saLiveRevenue: centsToMoney(call.saLiveRevenueCents ?? 0),
    currency: "ZAR",
  };
}

/* -------------------------------------------------------------------------- */
/* FINALIZE CALL BILLING                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Finalizes billing for a completed call.
 *
 * The customer balance, host earnings, earnings record, and call billing
 * status are changed atomically in one Firestore transaction.
 *
 * Repeated calls are safe once billingStatus is "finalized".
 */
export async function finalizeCallBilling(callId) {
  const normalizedCallId = requireId(callId, "Call ID");
  const callRef = callsCollection.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      throw makeError("Call session was not found.", 404);
    }

    const call = callSnapshot.data();

    // Idempotency: never charge or credit a finalized call again.
    if (call.billingStatus === FINAL_BILLING_STATUS) {
      return makeBillingResult(normalizedCallId, call, true);
    }

    if (call.status !== "completed") {
      throw makeError("Only completed calls can be billed.", 409);
    }

    if (call.billingStatus !== PENDING_BILLING_STATUS) {
      throw makeError("Call billing is not in a billable state.", 409);
    }

    const userId = requireId(call.userId, "User ID");
    const hostId = requireId(call.hostId, "Host ID");

    // Never bill a call that did not actually start.
    const startedAt = toDate(call.startedAt);
    const endedAt = toDate(call.endedAt);

    if (!startedAt || !endedAt) {
      throw makeError(
        "Call start and end timestamps are required for billing.",
        409
      );
    }

    if (endedAt.getTime() < startedAt.getTime()) {
      throw makeError("Call timestamps are inconsistent.", 409);
    }

    const durationSeconds = call.durationSeconds;

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw makeError("Call duration is invalid.", 409);
    }

    // Ensure stored duration is consistent with server-side timestamps.
    const timestampDuration = Math.floor(
      (endedAt.getTime() - startedAt.getTime()) / 1000
    );

    if (Math.abs(timestampDuration - durationSeconds) > 2) {
      throw makeError(
        "Stored call duration does not match its timestamps.",
        409
      );
    }

    const calculatedMinutes =
      durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : 0;

    if (!Number.isSafeInteger(calculatedMinutes)) {
      throw makeError("Call duration is too large.", 409);
    }

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);
    const earningRef = earningsCollection.doc(normalizedCallId);

    // Complete all reads before performing any writes.
    const [userSnapshot, hostSnapshot, earningSnapshot] =
      await Promise.all([
        transaction.get(userRef),
        transaction.get(hostRef),
        transaction.get(earningRef),
      ]);

    if (!userSnapshot.exists) {
      throw makeError("Customer account was not found.", 404);
    }

    if (!hostSnapshot.exists) {
      throw makeError("Host account was not found.", 404);
    }

    // A pre-existing earnings record with pending billing is inconsistent.
    // Never credit again automatically in this situation.
    if (earningSnapshot.exists) {
      throw makeError(
        "An earnings record already exists for this unfinalized call. Administrator review is required.",
        409
      );
    }

    const user = userSnapshot.data();
    const host = hostSnapshot.data();

    const availableMinutes = readMinutes(user.minutes, "Customer");

    // Charge only minutes available when billing is finalized.
    // This caps the charge if the balance is lower than call duration.
    const billableMinutes = Math.min(
      calculatedMinutes,
      availableMinutes
    );

    const customerChargeCents = moneyToCents(
      billableMinutes * SA_LIVE_PRICING.customerPricePerMinute
    );

    const hostEarningsCents = moneyToCents(
      billableMinutes * SA_LIVE_PRICING.hostEarningsPerMinute
    );

    const saLiveRevenueCents = moneyToCents(
      billableMinutes * SA_LIVE_PRICING.saLiveRevenuePerMinute
    );

    const currentAvailableCents = readCents(
      host.availableHostEarningsCents ?? 0,
      "Available host earnings"
    );

    const currentLifetimeCents = readCents(
      host.lifetimeHostEarningsCents ?? 0,
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
      throw makeError("Host earnings balance is too large.", 409);
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
      billingError: null,
      updatedAt: now,
    };

    // All balance changes and call finalization are atomic.
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

    // Deterministic document ID prevents a second earnings record for
    // the same call. Zero-minute calls do not create payable earnings.
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
      remainingCustomerMinutes: availableMinutes - billableMinutes,
      insufficientMinutes: calculatedMinutes > availableMinutes,
      currency: "ZAR",
    };
  });
}

/* -------------------------------------------------------------------------- */
/* GET CALL BILLING SUMMARY                                                   */
/* -------------------------------------------------------------------------- */

export async function getCallBillingSummary(callId) {
  const normalizedCallId = requireId(callId, "Call ID");

  const snapshot = await callsCollection
    .doc(normalizedCallId)
    .get();

  if (!snapshot.exists) {
    throw makeError("Call session was not found.", 404);
  }

  const call = snapshot.data();

  return {
    callId: normalizedCallId,
    status: call.status,
    billingStatus: call.billingStatus,
    billableMinutes: call.billableMinutes ?? 0,
    customerCharged: centsToMoney(call.customerChargeCents ?? 0),
    hostEarnings: centsToMoney(call.hostEarningsCents ?? 0),
    saLiveRevenue: centsToMoney(call.saLiveRevenueCents ?? 0),
    currency: "ZAR",
  };
}
