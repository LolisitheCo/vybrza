
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const paymentsCollection = db.collection("payments");
const withdrawalsCollection = db.collection("withdrawals");
const earningsCollection = db.collection("hostEarnings");
const callsCollection = db.collection("callSessions");

// ============================================================
// SA LIVE FINANCIAL CONFIGURATION
// ============================================================

export const CUSTOMER_PRICE_PER_MINUTE = 6;
export const HOST_EARNINGS_PER_MINUTE = 2;

export const PAYMENT_PACKAGES = Object.freeze({
  starter: Object.freeze({
    id: "starter",
    name: "5 Minutes",
    amount: 30,
    minutes: 5,
  }),

  ten_minutes: Object.freeze({
    id: "ten_minutes",
    name: "10 Minutes",
    amount: 60,
    minutes: 10,
  }),

  thirty_minutes: Object.freeze({
    id: "thirty_minutes",
    name: "30 Minutes",
    amount: 180,
    minutes: 30,
  }),

  sixty_minutes: Object.freeze({
    id: "sixty_minutes",
    name: "60 Minutes",
    amount: 360,
    minutes: 60,
  }),

  three_hour: Object.freeze({
    id: "three_hour",
    name: "3 Hours",
    amount: 1080,
    minutes: 180,
  }),
});

const MAX_ID_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_BANK_FIELD_LENGTH = 120;
const MAX_ACCOUNT_NUMBER_LENGTH = 40;
const MAX_REASON_LENGTH = 500;
const MAX_PAYOUT_REFERENCE_LENGTH = 200;

// ============================================================
// VALIDATION HELPERS
// ============================================================

function requireString(value, fieldName, maxLength = MAX_ID_LENGTH) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maxLength
  ) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return value.trim();
}

function requireDocumentId(value, fieldName) {
  const id = requireString(value, fieldName, MAX_ID_LENGTH);

  if (id.includes("/") || id.includes("\0")) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return id;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function toCentsFromRand(amount, fieldName = "Amount") {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(`${fieldName} must be a positive amount.`);
  }

  const cents = Math.round(amount * 100);

  if (
    !Number.isSafeInteger(cents) ||
    cents <= 0 ||
    Math.abs(amount * 100 - cents) > 0.000001
  ) {
    throw new Error(
      `${fieldName} must have no more than two decimal places.`
    );
  }

  return cents;
}

function readStoredCents(value, fieldName) {
  if (!validNonNegativeInteger(value ?? 0)) {
    throw new Error(`${fieldName} balance is invalid.`);
  }

  return value ?? 0;
}

function readStoredMinutes(value, fieldName) {
  if (!validNonNegativeInteger(value ?? 0)) {
    throw new Error(`${fieldName} minute balance is invalid.`);
  }

  return value ?? 0;
}

function validateEmail(email) {
  if (email === undefined || email === null || email === "") {
    return null;
  }

  if (
    typeof email !== "string" ||
    email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new Error("A valid payment email is required.");
  }

  return email.trim().toLowerCase();
}

function validateBankDetails(bankDetails) {
  if (
    !bankDetails ||
    typeof bankDetails !== "object" ||
    Array.isArray(bankDetails)
  ) {
    throw new Error("Bank details are required.");
  }

  const accountHolder = requireString(
    bankDetails.accountHolder,
    "Account holder",
    MAX_BANK_FIELD_LENGTH
  );

  const bankName = requireString(
    bankDetails.bankName,
    "Bank name",
    MAX_BANK_FIELD_LENGTH
  );

  const accountNumber = requireString(
    bankDetails.accountNumber,
    "Account number",
    MAX_ACCOUNT_NUMBER_LENGTH
  );

  const accountType = requireString(
    bankDetails.accountType,
    "Account type",
    60
  );

  if (
    /[\u0000-\u001F\u007F]/.test(accountHolder) ||
    /[\u0000-\u001F\u007F]/.test(bankName) ||
    /[\u0000-\u001F\u007F]/.test(accountType) ||
    !/^[a-zA-Z0-9 -]+$/.test(accountNumber)
  ) {
    throw new Error("Bank details are invalid.");
  }

  return {
    accountHolder,
    bankName,
    accountNumber,
    accountType,
  };
}

function validatePackageIntegrity(payment) {
  const paymentPackage = getPaymentPackage(payment.packageId);

  if (!paymentPackage) {
    throw new Error("The stored payment package is invalid.");
  }

  const expectedAmountCents = toCentsFromRand(
    paymentPackage.amount,
    "Package amount"
  );

  if (
    payment.provider !== "payfast" ||
    payment.currency !== "ZAR" ||
    payment.packageId !== paymentPackage.id ||
    payment.amount !== paymentPackage.amount ||
    payment.amountCents !== expectedAmountCents ||
    payment.minutes !== paymentPackage.minutes
  ) {
    throw new Error(
      "The stored payment does not match the configured package."
    );
  }

  return paymentPackage;
}

function validateWithdrawalRecord(withdrawal) {
  if (
    !withdrawal ||
    typeof withdrawal.hostId !== "string" ||
    withdrawal.hostId.trim().length === 0 ||
    !validPositiveInteger(withdrawal.amountCents) ||
    withdrawal.currency !== "ZAR"
  ) {
    throw new Error("The withdrawal record is invalid.");
  }
}

// ============================================================
// GET PAYMENT PACKAGE
// ============================================================

export function getPaymentPackage(packageId) {
  if (typeof packageId !== "string") {
    return null;
  }

  return PAYMENT_PACKAGES[packageId] ?? null;
}

// ============================================================
// CREATE PENDING PAYMENT
// ============================================================

export async function createPaymentRecord({
  userId,
  reference,
  packageId,
  email,
}) {
  userId = requireDocumentId(userId, "User ID");
  reference = requireDocumentId(reference, "Payment reference");

  const paymentPackage = getPaymentPackage(packageId);

  if (!paymentPackage) {
    throw new Error("Invalid payment package.");
  }

  const normalizedEmail = validateEmail(email);

  const amountCents = toCentsFromRand(
    paymentPackage.amount,
    "Package amount"
  );

  const userRef = usersCollection.doc(userId);
  const paymentRef = paymentsCollection.doc(reference);

  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const paymentSnapshot = await transaction.get(paymentRef);

    if (!userSnapshot.exists) {
      throw new Error("User account was not found.");
    }

    if (paymentSnapshot.exists) {
      throw new Error("Payment reference already exists.");
    }

    const now = new Date();

    transaction.create(paymentRef, {
      userId,
      reference,
      packageId: paymentPackage.id,
      packageName: paymentPackage.name,
      amount: paymentPackage.amount,
      amountCents,
      currency: "ZAR",
      minutes: paymentPackage.minutes,
      email: normalizedEmail,
      provider: "payfast",
      status: "pending",
      credited: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  return {
    reference,
    package: paymentPackage,
  };
}

// ============================================================
// GET PAYMENT BY REFERENCE
// ============================================================

export async function getPaymentByReference(reference) {
  if (
    typeof reference !== "string" ||
    reference.trim().length === 0 ||
    reference.trim().length > MAX_ID_LENGTH ||
    reference.includes("/")
  ) {
    return null;
  }

  const snapshot = await paymentsCollection
    .doc(reference.trim())
    .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

// ============================================================
// CREDIT VERIFIED PAYFAST PAYMENT ONCE
// ============================================================

export async function creditSuccessfulPayment(reference) {
  reference = requireDocumentId(reference, "Payment reference");

  const paymentRef = paymentsCollection.doc(reference);

  return db.runTransaction(async (transaction) => {
    const paymentSnapshot = await transaction.get(paymentRef);

    if (!paymentSnapshot.exists) {
      throw new Error("Payment record was not found.");
    }

    const payment = paymentSnapshot.data();

    if (payment.credited === true) {
      if (payment.status !== "complete") {
        throw new Error(
          "Payment has an inconsistent credited status."
        );
      }

      return {
        success: true,
        alreadyCredited: true,
        minutes: payment.minutes,
      };
    }

    if (payment.status !== "pending") {
      throw new Error("Payment is not pending.");
    }

    if (
      !payment.userId ||
      typeof payment.userId !== "string" ||
      !validPositiveInteger(payment.minutes)
    ) {
      throw new Error("Payment record is invalid.");
    }

    const paymentPackage = validatePackageIntegrity(payment);

    const userRef = usersCollection.doc(payment.userId);
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("User account was not found.");
    }

    const currentMinutes = readStoredMinutes(
      userSnapshot.get("minutes"),
      "User"
    );

    const newMinutes = currentMinutes + paymentPackage.minutes;

    if (!Number.isSafeInteger(newMinutes)) {
      throw new Error("The resulting minute balance is invalid.");
    }

    const now = new Date();

    transaction.update(userRef, {
      minutes: newMinutes,
      updatedAt: now,
    });

    transaction.update(paymentRef, {
      status: "complete",
      credited: true,
      creditedAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      alreadyCredited: false,
      minutes: paymentPackage.minutes,
    };
  });
}

// ============================================================
// RECORD HOST EARNINGS
// ============================================================
//
// hostId is the document ID in the hosts collection.
//
// IMPORTANT:
// Call only after the trusted call-billing service has completed
// billing and finalized the call. Do not call this from a browser
// or directly from Telegram user input.
//
// completedMinutes must be derived by the trusted backend.
// ============================================================

export async function recordHostEarnings({
  hostId,
  callId,
  completedMinutes,
}) {
  hostId = requireDocumentId(hostId, "Host ID");
  callId = requireDocumentId(callId, "Call ID");

  if (!validPositiveInteger(completedMinutes)) {
    throw new Error(
      "Completed minutes must be a positive whole number."
    );
  }

  const amountCents =
    completedMinutes * HOST_EARNINGS_PER_MINUTE * 100;

  if (!Number.isSafeInteger(amountCents)) {
    throw new Error("Host earnings amount is invalid.");
  }

  const hostRef = hostsCollection.doc(hostId);
  const callRef = callsCollection.doc(callId);
  const earningRef = earningsCollection.doc(callId);

  return db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);
    const callSnapshot = await transaction.get(callRef);
    const earningSnapshot = await transaction.get(earningRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    if (!callSnapshot.exists) {
      throw new Error("Call record was not found.");
    }

    const call = callSnapshot.data();

    if (
      call.hostId !== hostId ||
      call.status !== "completed" ||
      call.billingStatus !== "finalized" ||
      call.billableMinutes !== completedMinutes
    ) {
      throw new Error(
        "Call is not finalized with matching billable minutes."
      );
    }

    if (earningSnapshot.exists) {
      const existing = earningSnapshot.data();

      if (
        existing.hostId !== hostId ||
        existing.callId !== callId ||
        existing.completedMinutes !== completedMinutes ||
        existing.amountCents !== amountCents
      ) {
        throw new Error(
          "Existing host earnings do not match this call."
        );
      }

      return {
        success: true,
        alreadyRecorded: true,
        completedMinutes,
        amount: amountCents / 100,
      };
    }

    const currentAvailableCents = readStoredCents(
      hostSnapshot.get("availableHostEarningsCents"),
      "Available host earnings"
    );

    const currentLifetimeCents = readStoredCents(
      hostSnapshot.get("lifetimeHostEarningsCents"),
      "Lifetime host earnings"
    );

    const newAvailableCents = currentAvailableCents + amountCents;
    const newLifetimeCents = currentLifetimeCents + amountCents;

    if (
      !Number.isSafeInteger(newAvailableCents) ||
      !Number.isSafeInteger(newLifetimeCents)
    ) {
      throw new Error("The resulting host balance is invalid.");
    }

    const now = new Date();

    transaction.create(earningRef, {
      callId,
      hostId,
      completedMinutes,
      ratePerMinute: HOST_EARNINGS_PER_MINUTE,
      amount: amountCents / 100,
      amountCents,
      currency: "ZAR",
      status: "available",
      createdAt: now,
    });

    transaction.update(hostRef, {
      availableHostEarningsCents: newAvailableCents,
      lifetimeHostEarningsCents: newLifetimeCents,
      updatedAt: now,
    });

    return {
      success: true,
      alreadyRecorded: false,
      completedMinutes,
      amount: amountCents / 100,
    };
  });
}

// ============================================================
// GET HOST EARNINGS SUMMARY
// ============================================================

export async function getHostEarningsSummary(hostId) {
  hostId = requireDocumentId(hostId, "Host ID");

  const snapshot = await hostsCollection.doc(hostId).get();

  if (!snapshot.exists) {
    throw new Error("Host account was not found.");
  }

  return {
    hostId,
    currency: "ZAR",
    available:
      readStoredCents(
        snapshot.get("availableHostEarningsCents"),
        "Available host earnings"
      ) / 100,
    lifetime:
      readStoredCents(
        snapshot.get("lifetimeHostEarningsCents"),
        "Lifetime host earnings"
      ) / 100,
    pendingWithdrawals:
      readStoredCents(
        snapshot.get("pendingHostWithdrawalsCents"),
        "Pending host withdrawals"
      ) / 100,
  };
}

// ============================================================
// CREATE HOST WITHDRAWAL REQUEST
// ============================================================
//
// Reserves funds. Does not transfer money.
// hostId must come from the authenticated host identity.
// ============================================================

export async function createHostWithdrawalRequest({
  hostId,
  amount,
  bankDetails,
}) {
  hostId = requireDocumentId(hostId, "Host ID");

  const amountCents = toCentsFromRand(
    amount,
    "Withdrawal amount"
  );

  const validatedBankDetails = validateBankDetails(bankDetails);

  const hostRef = hostsCollection.doc(hostId);
  const withdrawalRef = withdrawalsCollection.doc();

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const host = hostSnapshot.data();

    if (host.status !== "active") {
      throw new Error("Only active hosts can request withdrawals.");
    }

    const availableCents = readStoredCents(
      host.availableHostEarningsCents,
      "Available host earnings"
    );

    const reservedCents = readStoredCents(
      host.pendingHostWithdrawalsCents,
      "Pending host withdrawals"
    );

    if (amountCents > availableCents) {
      throw new Error("Insufficient available host earnings.");
    }

    const newReservedCents = reservedCents + amountCents;

    if (!Number.isSafeInteger(newReservedCents)) {
      throw new Error("The resulting withdrawal balance is invalid.");
    }

    const now = new Date();

    transaction.create(withdrawalRef, {
      hostId,
      amount: amountCents / 100,
      amountCents,
      currency: "ZAR",
      bankDetails: validatedBankDetails,
      status: "pending",
      payoutMethod: "manual",
      adminNotified: false,
      createdAt: now,
      updatedAt: now,
    });

    transaction.update(hostRef, {
      availableHostEarningsCents: availableCents - amountCents,
      pendingHostWithdrawalsCents: newReservedCents,
      updatedAt: now,
    });
  });

  return {
    success: true,
    withdrawalId: withdrawalRef.id,
    amount: amountCents / 100,
    currency: "ZAR",
    status: "pending",
  };
}

// ============================================================
// MARK WITHDRAWAL AS PAID
// ============================================================
//
// An authorized administrator must confirm the real bank transfer
// before calling this function. It does not transfer money.
// ============================================================

export async function markHostWithdrawalPaid({
  withdrawalId,
  adminId,
  payoutReference,
}) {
  withdrawalId = requireDocumentId(
    withdrawalId,
    "Withdrawal ID"
  );

  adminId = requireDocumentId(adminId, "Administrator ID");

  const normalizedPayoutReference =
    payoutReference === undefined || payoutReference === null
      ? null
      : requireString(
          payoutReference,
          "Payout reference",
          MAX_PAYOUT_REFERENCE_LENGTH
        );

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot = await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request was not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

    validateWithdrawalRecord(withdrawal);

    if (withdrawal.status === "paid") {
      return {
        success: true,
        alreadyPaid: true,
        withdrawalId,
      };
    }

    if (withdrawal.status !== "pending") {
      throw new Error(
        "Only pending withdrawals can be marked as paid."
      );
    }

    const hostRef = hostsCollection.doc(withdrawal.hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const pendingCents = readStoredCents(
      hostSnapshot.get("pendingHostWithdrawalsCents"),
      "Pending host withdrawals"
    );

    if (pendingCents < withdrawal.amountCents) {
      throw new Error(
        "Pending withdrawal balance does not match the request."
      );
    }

    const now = new Date();

    transaction.update(hostRef, {
      pendingHostWithdrawalsCents:
        pendingCents - withdrawal.amountCents,
      updatedAt: now,
    });

    transaction.update(withdrawalRef, {
      status: "paid",
      payoutMethod: "manual",
      payoutReference: normalizedPayoutReference,
      processedBy: adminId,
      paidAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      alreadyPaid: false,
      withdrawalId,
      amount: withdrawal.amountCents / 100,
    };
  });
}

// ============================================================
// REJECT WITHDRAWAL
// ============================================================

export async function rejectHostWithdrawal({
  withdrawalId,
  adminId,
  reason,
}) {
  withdrawalId = requireDocumentId(
    withdrawalId,
    "Withdrawal ID"
  );

  adminId = requireDocumentId(adminId, "Administrator ID");
  reason = requireString(reason, "Rejection reason", MAX_REASON_LENGTH);

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot = await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request was not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

    validateWithdrawalRecord(withdrawal);

    if (withdrawal.status !== "pending") {
      throw new Error(
        "Only pending withdrawals can be rejected."
      );
    }

    const hostRef = hostsCollection.doc(withdrawal.hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const host = hostSnapshot.data();

    const availableCents = readStoredCents(
      host.availableHostEarningsCents,
      "Available host earnings"
    );

    const pendingCents = readStoredCents(
      host.pendingHostWithdrawalsCents,
      "Pending host withdrawals"
    );

    if (pendingCents < withdrawal.amountCents) {
      throw new Error(
        "Pending withdrawal balance does not match the request."
      );
    }

    const newAvailableCents = availableCents + withdrawal.amountCents;

    if (!Number.isSafeInteger(newAvailableCents)) {
      throw new Error("The resulting host balance is invalid.");
    }

    const now = new Date();

    transaction.update(hostRef, {
      availableHostEarningsCents: newAvailableCents,
      pendingHostWithdrawalsCents:
        pendingCents - withdrawal.amountCents,
      updatedAt: now,
    });

    transaction.update(withdrawalRef, {
      status: "rejected",
      rejectionReason: reason,
      processedBy: adminId,
      rejectedAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      withdrawalId,
      status: "rejected",
    };
  });
}
