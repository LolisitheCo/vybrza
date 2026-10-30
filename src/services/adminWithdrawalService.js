
import { db } from "../config/firebase.js";

const withdrawalsCollection = db.collection("hostWithdrawals");
const hostsCollection = db.collection("hosts");

const MAX_WITHDRAWALS_PER_REQUEST = 500;
const MAX_REFERENCE_LENGTH = 150;
const MAX_REASON_LENGTH = 500;

const ALLOWED_STATUSES = new Set([
  "pending",
  "paid",
  "rejected",
  "all",
]);

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireDocumentId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    value.includes("/") ||
    value.includes("\0")
  ) {
    throw createError(`${fieldName} is invalid.`, 400);
  }

  return value.trim();
}

function requireAdminUid(adminUid) {
  if (
    typeof adminUid !== "string" ||
    !adminUid.trim() ||
    adminUid.trim().length > 128
  ) {
    throw createError("An authenticated admin is required.", 401);
  }

  return adminUid.trim();
}

function readCents(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createError(`${fieldName} is invalid.`, 409);
  }

  return value;
}

function readWithdrawalAmount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createError("The withdrawal amount is invalid.", 409);
  }

  return value;
}

function toDate(value) {
  if (!value) return null;

  const date =
    typeof value.toDate === "function"
      ? value.toDate()
      : new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function toSafeBankDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  // Return only the fields required by an admin to process a payout.
  return {
    accountHolder:
      typeof value.accountHolder === "string"
        ? value.accountHolder
        : "",
    bankName:
      typeof value.bankName === "string"
        ? value.bankName
        : "",
    accountNumber:
      typeof value.accountNumber === "string"
        ? value.accountNumber
        : "",
    accountType:
      typeof value.accountType === "string"
        ? value.accountType
        : "",
    branchCode:
      typeof value.branchCode === "string"
        ? value.branchCode
        : "",
  };
}

function serializeWithdrawal(document) {
  const data = document.data() ?? {};

  const amountCents =
    Number.isSafeInteger(data.amountCents) &&
    data.amountCents >= 0
      ? data.amountCents
      : 0;

  return {
    id: document.id,

    hostId: data.hostId ?? null,
    hostFirebaseUid: data.hostFirebaseUid ?? null,
    hostUsername: data.hostUsername ?? null,

    amountCents,
    amount: Number((amountCents / 100).toFixed(2)),
    currency: data.currency === "ZAR" ? "ZAR" : "ZAR",

    bankDetails: toSafeBankDetails(data.bankDetails),
    bankDetailsConfirmed: data.bankDetailsConfirmed === true,

    status: data.status ?? "pending",
    payoutMethod: data.payoutMethod ?? "manual",
    payoutNote:
      typeof data.payoutNote === "string"
        ? data.payoutNote
        : "",

    requestedAt: toDate(data.requestedAt),
    updatedAt: toDate(data.updatedAt),
    paidAt: toDate(data.paidAt),
    rejectedAt: toDate(data.rejectedAt),

    reviewedBy: data.reviewedBy ?? null,
    rejectionReason: data.rejectionReason ?? null,
    payoutReference: data.payoutReference ?? null,
  };
}

function requireHostId(withdrawal) {
  if (
    typeof withdrawal.hostId !== "string" ||
    !withdrawal.hostId.trim() ||
    withdrawal.hostId.includes("/")
  ) {
    throw createError(
      "The withdrawal has no valid associated host.",
      409
    );
  }

  return withdrawal.hostId.trim();
}

function requireZar(withdrawal) {
  if (
    withdrawal.currency !== undefined &&
    withdrawal.currency !== "ZAR"
  ) {
    throw createError(
      "This withdrawal has an unsupported currency.",
      409
    );
  }
}

/**
 * Returns admin withdrawal records.
 *
 * IMPORTANT:
 * This function exposes bank account details. Its route MUST be
 * protected by verifyFirebaseToken and requireAdmin middleware.
 */
export async function getAdminWithdrawals(status = "pending") {
  if (
    typeof status !== "string" ||
    !ALLOWED_STATUSES.has(status)
  ) {
    throw createError("Invalid withdrawal status.", 400);
  }

  let query = withdrawalsCollection;

  if (status !== "all") {
    query = query.where("status", "==", status);
  }

  const snapshot = await query
    .limit(MAX_WITHDRAWALS_PER_REQUEST)
    .get();

  const withdrawals = snapshot.docs.map(serializeWithdrawal);

  withdrawals.sort((a, b) => {
    const dateA = a.requestedAt
      ? new Date(a.requestedAt).getTime()
      : 0;

    const dateB = b.requestedAt
      ? new Date(b.requestedAt).getTime()
      : 0;

    return dateB - dateA;
  });

  return withdrawals;
}

/**
 * Records an external payout that has already been completed.
 *
 * This function does NOT transfer money.
 * The admin must complete the payout through the approved payment
 * process before calling this function.
 *
 * The request can only move from pending to paid once.
 */
export async function markWithdrawalPaid(
  withdrawalId,
  adminUid,
  payoutReference = ""
) {
  withdrawalId = requireDocumentId(
    withdrawalId,
    "Withdrawal ID"
  );

  adminUid = requireAdminUid(adminUid);

  if (
    payoutReference !== undefined &&
    payoutReference !== null &&
    typeof payoutReference !== "string"
  ) {
    throw createError("The payout reference is invalid.", 400);
  }

  const reference = String(payoutReference ?? "").trim();

  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw createError("The payout reference is too long.", 400);
  }

  const withdrawalRef =
    withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);

    if (!snapshot.exists) {
      throw createError(
        "Withdrawal request not found.",
        404
      );
    }

    const withdrawal = snapshot.data();

    if (withdrawal.status !== "pending") {
      throw createError(
        "Only pending withdrawals can be marked as paid.",
        409
      );
    }

    const hostId = requireHostId(withdrawal);
    requireZar(withdrawal);

    // Confirm that the host record still exists.
    const hostRef = hostsCollection.doc(hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw createError(
        "The associated host account was not found.",
        409
      );
    }

    if (
      withdrawal.hostFirebaseUid &&
      hostSnapshot.data().firebaseUid &&
      withdrawal.hostFirebaseUid !==
        hostSnapshot.data().firebaseUid
    ) {
      throw createError(
        "The withdrawal host details do not match the host account.",
        409
      );
    }

    const amountCents = readWithdrawalAmount(
      withdrawal.amountCents
    );

    const now = new Date();

    transaction.update(withdrawalRef, {
      status: "paid",
      payoutNote: "External payout completed and recorded by admin.",
      payoutReference: reference || null,
      paidAt: now,
      updatedAt: now,
      reviewedBy: adminUid,
    });

    return {
      withdrawalId,
      status: "paid",
      amountCents,
      amount: Number((amountCents / 100).toFixed(2)),
      currency: "ZAR",
    };
  });
}

/**
 * Rejects a pending withdrawal and returns the reserved amount
 * to the host's available earnings balance.
 *
 * The refund and rejection happen atomically. A second rejection
 * cannot refund the same withdrawal again.
 */
export async function rejectWithdrawal(
  withdrawalId,
  adminUid,
  reason
) {
  withdrawalId = requireDocumentId(
    withdrawalId,
    "Withdrawal ID"
  );

  adminUid = requireAdminUid(adminUid);

  if (typeof reason !== "string") {
    throw createError(
      "Enter a rejection reason between 3 and 500 characters.",
      400
    );
  }

  const rejectionReason = reason.trim();

  if (
    rejectionReason.length < 3 ||
    rejectionReason.length > MAX_REASON_LENGTH
  ) {
    throw createError(
      "Enter a rejection reason between 3 and 500 characters.",
      400
    );
  }

  const withdrawalRef =
    withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);

    if (!snapshot.exists) {
      throw createError(
        "Withdrawal request not found.",
        404
      );
    }

    const withdrawal = snapshot.data();

    if (withdrawal.status !== "pending") {
      throw createError(
        "Only pending withdrawals can be rejected.",
        409
      );
    }

    const hostId = requireHostId(withdrawal);
    requireZar(withdrawal);

    const amountCents = readWithdrawalAmount(
      withdrawal.amountCents
    );

    const hostRef = hostsCollection.doc(hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw createError(
        "The host account was not found. The withdrawal remains pending.",
        409
      );
    }

    const host = hostSnapshot.data();

    if (
      withdrawal.hostFirebaseUid &&
      host.firebaseUid &&
      withdrawal.hostFirebaseUid !== host.firebaseUid
    ) {
      throw createError(
        "The withdrawal host details do not match the host account.",
        409
      );
    }

    const availableCents = readCents(
      host.availableHostEarningsCents ?? 0,
      "Available host earnings balance"
    );

    const refundedBalance = availableCents + amountCents;

    if (!Number.isSafeInteger(refundedBalance)) {
      throw createError(
        "The refunded host earnings balance is too large.",
        409
      );
    }

    const now = new Date();

    // Both writes commit together or neither write commits.
    transaction.update(hostRef, {
      availableHostEarningsCents: refundedBalance,
      updatedAt: now,
    });

    transaction.update(withdrawalRef, {
      status: "rejected",
      payoutNote: "Withdrawal rejected; reserved balance returned.",
      rejectionReason,
      rejectedAt: now,
      updatedAt: now,
      reviewedBy: adminUid,
    });

    return {
      withdrawalId,
      status: "rejected",
      refundedCents: amountCents,
      refundedAmount: Number(
        (amountCents / 100).toFixed(2)
      ),
      currency: "ZAR",
    };
  });
}

