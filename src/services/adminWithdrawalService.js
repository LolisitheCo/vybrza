
import { db } from "../config/firebase.js";

const withdrawalsCollection = db.collection("hostWithdrawals");
const hostsCollection = db.collection("hosts");

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function toNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeWithdrawal(document) {
  const data = document.data();

  return {
    id: document.id,
    hostId: data.hostId ?? null,
    hostFirebaseUid: data.hostFirebaseUid ?? null,
    hostUsername: data.hostUsername ?? null,

    amountCents: Math.max(0, Math.floor(toNumber(data.amountCents))),
    amount: Number((toNumber(data.amountCents) / 100).toFixed(2)),
    currency: data.currency ?? "ZAR",

    // This information is only returned by the admin service.
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

/*
|--------------------------------------------------------------------------
| LIST WITHDRAWALS
|--------------------------------------------------------------------------
*/

export async function getAdminWithdrawals(status = "pending") {
  const allowedStatuses = ["pending", "paid", "rejected", "all"];

  if (!allowedStatuses.includes(status)) {
    throw new Error("Invalid withdrawal status.");
  }

  let query = withdrawalsCollection;

  if (status !== "all") {
    query = query.where("status", "==", status);
  }

  const snapshot = await query.get();

  const withdrawals = snapshot.docs.map(serializeWithdrawal);

  withdrawals.sort((a, b) => {
    return (
      new Date(b.requestedAt ?? 0).getTime() -
      new Date(a.requestedAt ?? 0).getTime()
    );
  });

  return withdrawals;
}

/*
|--------------------------------------------------------------------------
| MARK WITHDRAWAL AS PAID
|--------------------------------------------------------------------------
|
| This records a payout that the admin has already completed externally.
| It does not transfer money automatically.
|
*/

export async function markWithdrawalPaid(
  withdrawalId,
  adminUid,
  payoutReference = ""
) {
  if (!withdrawalId) {
    throw new Error("A withdrawal ID is required.");
  }

  if (!adminUid) {
    throw new Error("An authenticated admin is required.");
  }

  const reference = String(payoutReference ?? "").trim();

  if (reference.length > 150) {
    throw new Error("The payout reference is too long.");
  }

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot = await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

    if (withdrawal.status !== "pending") {
      throw new Error("Only pending withdrawals can be marked as paid.");
    }

    const amountCents = Math.floor(toNumber(withdrawal.amountCents));

    if (amountCents <= 0) {
      throw new Error("The withdrawal amount is invalid.");
    }

    transaction.update(withdrawalRef, {
      status: "paid",
      payoutNote: "Payout recorded by an admin.",
      payoutReference: reference || null,
      paidAt: new Date(),
      updatedAt: new Date(),
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

/*
|--------------------------------------------------------------------------
| REJECT WITHDRAWAL AND REFUND RESERVED BALANCE
|--------------------------------------------------------------------------
*/

export async function rejectWithdrawal(
  withdrawalId,
  adminUid,
  reason
) {
  if (!withdrawalId) {
    throw new Error("A withdrawal ID is required.");
  }

  if (!adminUid) {
    throw new Error("An authenticated admin is required.");
  }

  const rejectionReason = String(reason ?? "").trim();

  if (rejectionReason.length < 3 || rejectionReason.length > 500) {
    throw new Error("Enter a rejection reason between 3 and 500 characters.");
  }

  const withdrawalRef = withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot = await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

    if (withdrawal.status !== "pending") {
      throw new Error("Only pending withdrawals can be rejected.");
    }

    const hostId = withdrawal.hostId;

    if (!hostId) {
      throw new Error("The withdrawal has no associated host.");
    }

    const amountCents = Math.floor(toNumber(withdrawal.amountCents));

    if (amountCents <= 0) {
      throw new Error("The withdrawal amount is invalid.");
    }

    const hostRef = hostsCollection.doc(hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error(
        "The host account was not found. The withdrawal remains pending."
      );
    }

    const host = hostSnapshot.data();

    const availableCents = Math.max(
      0,
      Math.floor(toNumber(host.availableHostEarningsCents))
    );

    transaction.update(hostRef, {
      availableHostEarningsCents: availableCents + amountCents,
      updatedAt: new Date(),
    });

    transaction.update(withdrawalRef, {
      status: "rejected",
      payoutNote: "Withdrawal rejected; reserved balance returned.",
      rejectionReason,
      rejectedAt: new Date(),
      updatedAt: new Date(),
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
