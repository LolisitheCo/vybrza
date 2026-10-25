
import { db } from "../config/firebase.js";

const withdrawalsCollection = db.collection("hostWithdrawals");
const hostsCollection = db.collection("hosts");

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

function serializeWithdrawal(document) {
  const data = document.data();

  const amountCents =
    Number.isSafeInteger(data.amountCents) && data.amountCents >= 0
      ? data.amountCents
      : 0;

  return {
    id: document.id,
    hostId: data.hostId ?? null,
    hostFirebaseUid: data.hostFirebaseUid ?? null,
    hostUsername: data.hostUsername ?? null,

    amountCents,
    amount: Number((amountCents / 100).toFixed(2)),
    currency: data.currency ?? "ZAR",

    bankDetails: data.bankDetails ?? null,
    bankDetailsConfirmed: data.bankDetailsConfirmed === true,

    status: data.status ?? "pending",
    payoutMethod: data.payoutMethod ?? "manual",
    payoutNote: data.payoutNote ?? "",

    requestedAt: toDate(data.requestedAt),
    updatedAt: toDate(data.updatedAt),
    paidAt: toDate(data.paidAt),
    rejectedAt: toDate(data.rejectedAt),

    reviewedBy: data.reviewedBy ?? null,
    rejectionReason: data.rejectionReason ?? null,
    payoutReference: data.payoutReference ?? null,
  };
}

export async function getAdminWithdrawals(status = "pending") {
  const allowedStatuses = ["pending", "paid", "rejected", "all"];

  if (!allowedStatuses.includes(status)) {
    throw createError("Invalid withdrawal status.", 400);
  }

  let query = withdrawalsCollection;

  if (status !== "all") {
    query = query.where("status", "==", status);
  }

  const snapshot = await query.get();
  const withdrawals = snapshot.docs.map(serializeWithdrawal);

  withdrawals.sort(
    (a, b) =>
      new Date(b.requestedAt ?? 0).getTime() -
      new Date(a.requestedAt ?? 0).getTime()
  );

  return withdrawals;
}

/*
 * Records an external payout that has already been completed.
 * This function does not transfer money.
 */
export async function markWithdrawalPaid(
  withdrawalId,
  adminUid,
  payoutReference = ""
) {
  withdrawalId = requireDocumentId(withdrawalId, "Withdrawal ID");
  adminUid = requireAdminUid(adminUid);

  if (
    payoutReference !== undefined &&
    payoutReference !== null &&
    typeof payoutReference !== "string"
  ) {
    throw createError("The payout reference is invalid.", 400);
  }

  const reference = String(payoutReference ?? "").trim();

  if (reference.length > 150) {
    throw createError("The payout reference is too long.", 400);
  }

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);

    if (!snapshot.exists) {
      throw createError("Withdrawal request not found.", 404);
    }

    const withdrawal = snapshot.data();

    if (withdrawal.status !== "pending") {
      throw createError(
        "Only pending withdrawals can be marked as paid.",
        409
      );
    }

    const amountCents = readWithdrawalAmount(withdrawal.amountCents);
    const now = new Date();

    transaction.update(withdrawalRef, {
      status: "paid",
      payoutNote: "Payout recorded by an admin.",
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
      currency: withdrawal.currency ?? "ZAR",
    };
  });
}

export async function rejectWithdrawal(
  withdrawalId,
  adminUid,
  reason
) {
  withdrawalId = requireDocumentId(withdrawalId, "Withdrawal ID");
  adminUid = requireAdminUid(adminUid);

  if (typeof reason !== "string") {
    throw createError(
      "Enter a rejection reason between 3 and 500 characters.",
      400
    );
  }

  const rejectionReason = reason.trim();

  if (rejectionReason.length < 3 || rejectionReason.length > 500) {
    throw createError(
      "Enter a rejection reason between 3 and 500 characters.",
      400
    );
  }

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);

    if (!snapshot.exists) {
      throw createError("Withdrawal request not found.", 404);
    }

    const withdrawal = snapshot.data();

    if (withdrawal.status !== "pending") {
      throw createError(
        "Only pending withdrawals can be rejected.",
        409
      );
    }

    const hostId = withdrawal.hostId;

    if (typeof hostId !== "string" || !hostId.trim()) {
      throw createError(
        "The withdrawal has no associated host.",
        409
      );
    }

    const amountCents = readWithdrawalAmount(withdrawal.amountCents);
    const hostRef = hostsCollection.doc(hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw createError(
        "The host account was not found. The withdrawal remains pending.",
        409
      );
    }

    const host = hostSnapshot.data();

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

    // The refund and rejection happen atomically.
    // A second rejection cannot refund the same request again.
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
      refundedAmount: Number((amountCents / 100).toFixed(2)),
      currency: withdrawal.currency ?? "ZAR",
    };
  });
}
