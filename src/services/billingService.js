
import { db } from "../config/firebase.js";

// ============================================================
// SA LIVE BILLING SERVICE — PER-SECOND BILLING
//
// Customer: R6 per minute = R0.10 per second
// Host:     R2 per minute
// SA LIVE:  R4 per minute
//
// Existing packages and users.minutes balances are preserved.
// Partial-minute usage is tracked using secondsUsedRemainder.
// ============================================================

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callsCollection = db.collection("callSessions");
const earningsCollection = db.collection("hostEarnings");

export const SA_LIVE_PRICING = Object.freeze({
  customerPricePerMinute: 6,
  hostEarningsPerMinute: 2,
  saLiveRevenuePerMinute: 4,

  customerPriceCentsPerSecond: 10,
  hostEarningsCentsPerMinute: 200,
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

function readSecondsRemainder(value, fieldName) {
  const seconds = value ?? 0;

  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > 59
  ) {
    throw makeError(
      `${fieldName} seconds remainder is invalid.`,
      409
    );
  }

  return seconds;
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

function getAvailableSeconds(minutes, secondsRemainder) {
  const totalSeconds = minutes * 60 - secondsRemainder;

  if (
    !Number.isSafeInteger(totalSeconds) ||
    totalSeconds < 0
  ) {
    throw makeError("Customer available seconds are invalid.", 409);
  }

  return totalSeconds;
}

/**
 * Converts remaining seconds back into the existing
 * minutes + secondsUsedRemainder balance structure.
 *
 * Example:
 * 270 remaining seconds = 5 minutes - 30 seconds used.
 */
function secondsToBalance(remainingSeconds) {
  if (
    !Number.isSafeInteger(remainingSeconds) ||
    remainingSeconds < 0
  ) {
    throw makeError("Remaining customer balance is invalid.", 409);
  }

  const minutes = Math.ceil(remainingSeconds / 60);

  const secondsUsedRemainder =
    minutes * 60 - remainingSeconds;

  return {
    minutes,
    secondsUsedRemainder,
  };
}

function calculateCustomerChargeCents(seconds) {
  const amount =
    seconds * SA_LIVE_PRICING.customerPriceCentsPerSecond;

  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw makeError("Customer billing amount is invalid.", 500);
  }

  return amount;
}

/**
 * Host earnings are calculated from total elapsed seconds.
 * The final amount is rounded to the nearest cent.
 */
function calculateHostEarningsCents(seconds) {
  const amount = Math.round(
    (
      seconds *
      SA_LIVE_PRICING.hostEarningsCentsPerMinute
    ) / 60
  );

  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw makeError("Host earnings amount is invalid.", 500);
  }

  return amount;
}

function makeBillingResult(callId, call, alreadyFinalized) {
  return {
    success: true,
    alreadyFinalized,
    callId,

    billingStatus: call.billingStatus,

    durationSeconds: call.durationSeconds ?? 0,
    billableSeconds: call.billableSeconds ?? 0,

    // Legacy compatibility field.
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

/* -------------------------------------------------------------------------- */
/* FINALIZE CALL BILLING                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Finalizes billing for a completed call.
 *
 * The following operations happen atomically:
 *
 * 1. Deduct actual seconds from customer balance.
 * 2. Calculate customer charge.
 * 3. Calculate host earnings.
 * 4. Calculate SA LIVE revenue.
 * 5. Create host earnings record.
 * 6. Finalize call billing.
 *
 * Repeated calls are safe after billingStatus becomes finalized.
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

    // Idempotency.
    if (call.billingStatus === FINAL_BILLING_STATUS) {
      return makeBillingResult(
        normalizedCallId,
        call,
        true
      );
    }

    if (call.status !== "completed") {
      throw makeError(
        "Only completed calls can be billed.",
        409
      );
    }

    if (call.billingStatus !== PENDING_BILLING_STATUS) {
      throw makeError(
        "Call billing is not in a billable state.",
        409
      );
    }

    const userId = requireId(call.userId, "User ID");
    const hostId = requireId(call.hostId, "Host ID");

    const startedAt = toDate(call.startedAt);
    const endedAt = toDate(call.endedAt);

    if (!startedAt || !endedAt) {
      throw makeError(
        "Call start and end timestamps are required for billing.",
        409
      );
    }

    if (endedAt.getTime() < startedAt.getTime()) {
      throw makeError(
        "Call timestamps are inconsistent.",
        409
      );
    }

    const durationSeconds = call.durationSeconds;

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw makeError("Call duration is invalid.", 409);
    }

    // Verify duration against trusted backend timestamps.
    const timestampDuration = Math.floor(
      (endedAt.getTime() - startedAt.getTime()) / 1000
    );

    if (Math.abs(timestampDuration - durationSeconds) > 2) {
      throw makeError(
        "Stored call duration does not match its timestamps.",
        409
      );
    }

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);
    const earningRef = earningsCollection.doc(normalizedCallId);

    // All reads must happen before writes.
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
      throw makeError(
        "Customer account was not found.",
        404
      );
    }

    if (!hostSnapshot.exists) {
      throw makeError(
        "Host account was not found.",
        404
      );
    }

    if (earningSnapshot.exists) {
      throw makeError(
        "An earnings record already exists for this unfinalized call. Administrator review is required.",
        409
      );
    }

    const user = userSnapshot.data();
    const host = hostSnapshot.data();

    // Existing customer balance remains in whole minutes.
    const availableMinutes = readMinutes(
      user.minutes,
      "Customer"
    );

    // Partial-minute usage already accumulated before this call.
    const currentSecondsRemainder = readSecondsRemainder(
      user.secondsUsedRemainder,
      "Customer"
    );

    const currentAvailableSeconds = getAvailableSeconds(
      availableMinutes,
      currentSecondsRemainder
    );

    // Snapshot recorded when the call actually starts.
    // Older call records remain compatible.
    const minutesAtStart =
      call.minutesAtStart === undefined
        ? availableMinutes
        : readMinutes(
            call.minutesAtStart,
            "Call-start customer"
          );

    const secondsRemainderAtStart =
      call.secondsUsedRemainderAtStart === undefined
        ? currentSecondsRemainder
        : readSecondsRemainder(
            call.secondsUsedRemainderAtStart,
            "Call-start customer"
          );

    const availableSecondsAtStart = getAvailableSeconds(
      minutesAtStart,
      secondsRemainderAtStart
    );

    // Never bill more than:
    // - actual elapsed seconds,
    // - balance available when the call started,
    // - balance currently available.
    const billableSeconds = Math.min(
      durationSeconds,
      availableSecondsAtStart,
      currentAvailableSeconds
    );

    const remainingSeconds =
      currentAvailableSeconds - billableSeconds;

    const newBalance = secondsToBalance(remainingSeconds);

    // Calculate customer charge in cents.
    const customerChargeCents =
      calculateCustomerChargeCents(billableSeconds);

    // Calculate host earnings in cents.
    const hostEarningsCents =
      calculateHostEarningsCents(billableSeconds);

    // SA LIVE receives the remaining amount.
    // This guarantees the financial totals always balance.
    const saLiveRevenueCents =
      customerChargeCents - hostEarningsCents;

    if (
      !Number.isSafeInteger(saLiveRevenueCents) ||
      saLiveRevenueCents < 0
    ) {
      throw makeError(
        "SA LIVE revenue calculation is invalid.",
        500
      );
    }

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
      throw makeError(
        "Host earnings balance is too large.",
        409
      );
    }

    const now = new Date();

    // Kept for compatibility with older dashboard/API code.
    const billableMinutes =
      billableSeconds > 0
        ? Math.ceil(billableSeconds / 60)
        : 0;

    const billingFields = {
      billingStatus: FINAL_BILLING_STATUS,

      durationSeconds,
      billableSeconds,
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

    // Deduct the actual seconds while preserving the old
    // whole-minute package balance system.
    transaction.update(userRef, {
      minutes: newBalance.minutes,
      secondsUsedRemainder: newBalance.secondsUsedRemainder,
      updatedAt: now,
    });

    // Credit host earnings.
    transaction.update(hostRef, {
      availableHostEarningsCents: newAvailableCents,
      lifetimeHostEarningsCents: newLifetimeCents,
      updatedAt: now,
    });

    // Finalize the call.
    transaction.update(callRef, billingFields);

    // One deterministic earnings record per call.
    if (billableSeconds > 0) {
      transaction.create(earningRef, {
        callId: normalizedCallId,
        userId,
        hostId,

        completedSeconds: billableSeconds,
        completedMinutes: billableMinutes,

        ratePerMinute:
          SA_LIVE_PRICING.hostEarningsPerMinute,

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

      durationSeconds,
      billableSeconds,
      billableMinutes,

      customerCharged: centsToMoney(customerChargeCents),
      hostEarnings: centsToMoney(hostEarningsCents),
      saLiveRevenue: centsToMoney(saLiveRevenueCents),

      remainingCustomerMinutes: newBalance.minutes,
      remainingCustomerSeconds: remainingSeconds,

      secondsUsedRemainder: newBalance.secondsUsedRemainder,

      insufficientSeconds:
        durationSeconds > currentAvailableSeconds,

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

    durationSeconds: call.durationSeconds ?? 0,
    billableSeconds: call.billableSeconds ?? 0,

    // Legacy compatibility.
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
