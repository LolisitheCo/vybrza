
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const earningsCollection = db.collection("hostEarnings");
const callsCollection = db.collection("callSessions");
const withdrawalsCollection = db.collection("hostWithdrawals");

const HOST_RATE_CENTS = 200;
const TIME_ZONE = "Africa/Johannesburg";

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
    return value.toDate();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toZAR(cents) {
  return Number((toNumber(cents) / 100).toFixed(2));
}

function getSouthAfricanDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

function getDateKey(date) {
  const parts = getSouthAfricanDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getMondayDateKey(date) {
  const parts = getSouthAfricanDateParts(date);
  const day = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  ).getUTCDay();

  const daysSinceMonday = (day + 6) % 7;

  const monday = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day) - daysSinceMonday
    )
  );

  return monday.toISOString().slice(0, 10);
}

function getMonthKey(date) {
  const parts = getSouthAfricanDateParts(date);
  return `${parts.year}-${parts.month}`;
}

function validateBankDetails(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Bank details are required.");
  }

  const details = {
    accountHolder: String(input.accountHolder ?? "").trim(),
    bankName: String(input.bankName ?? "").trim(),
    accountNumber: String(input.accountNumber ?? "").trim(),
    accountType: String(input.accountType ?? "").trim(),
    branchCode: String(input.branchCode ?? "").trim(),
  };

  if (details.accountHolder.length < 2 || details.accountHolder.length > 100) {
    throw new Error("Enter a valid account holder name.");
  }

  if (details.bankName.length < 2 || details.bankName.length > 100) {
    throw new Error("Enter a valid bank name.");
  }

  if (
    !/^[a-zA-Z0-9 -]{4,30}$/.test(details.accountNumber)
  ) {
    throw new Error("Enter a valid account number.");
  }

  const allowedAccountTypes = [
    "savings",
    "current",
    "cheque",
    "transmission",
  ];

  details.accountType = details.accountType.toLowerCase();

  if (!allowedAccountTypes.includes(details.accountType)) {
    throw new Error(
      "Choose savings, current, cheque, or transmission as the account type."
    );
  }

  if (details.branchCode.length > 20) {
    throw new Error("The branch code is too long.");
  }

  return details;
}

function getEarningAmountCents(earning) {
  if (Number.isSafeInteger(earning.amountCents)) {
    return earning.amountCents;
  }

  if (Number.isFinite(Number(earning.amount))) {
    return Math.round(Number(earning.amount) * 100);
  }

  const minutes = Math.max(
    0,
    Math.floor(toNumber(earning.completedMinutes))
  );

  return minutes * HOST_RATE_CENTS;
}

/*
|--------------------------------------------------------------------------
| HOST EARNINGS SUMMARY
|--------------------------------------------------------------------------
|
| Earnings are read from hostEarnings.
| The host document's availableHostEarningsCents is the authoritative
| balance available for withdrawal.
|
*/

export async function getHostEarningsSummary(hostId) {
  if (!hostId) {
    throw new Error("A host ID is required.");
  }

  const hostRef = hostsCollection.doc(hostId);
  const hostSnapshot = await hostRef.get();

  if (!hostSnapshot.exists) {
    throw new Error("Host account not found.");
  }

  const host = hostSnapshot.data();

  const [earningsSnapshot, callsSnapshot, withdrawalsSnapshot] =
    await Promise.all([
      earningsCollection.where("hostId", "==", hostId).get(),
      callsCollection.where("hostId", "==", hostId).get(),
      withdrawalsCollection.where("hostId", "==", hostId).get(),
    ]);

  const now = new Date();
  const todayKey = getDateKey(now);
  const weekStartKey = getMondayDateKey(now);
  const monthKey = getMonthKey(now);

  const summary = {
    today: { earningsCents: 0, billableMinutes: 0 },
    week: { earningsCents: 0, billableMinutes: 0 },
    month: { earningsCents: 0, billableMinutes: 0 },
    allTime: { earningsCents: 0, billableMinutes: 0 },
  };

  for (const document of earningsSnapshot.docs) {
    const earning = document.data();
    const amountCents = getEarningAmountCents(earning);
    const minutes = Math.max(
      0,
      Math.floor(toNumber(earning.completedMinutes))
    );
    const createdAt = toDate(earning.createdAt);

    summary.allTime.earningsCents += amountCents;
    summary.allTime.billableMinutes += minutes;

    if (!createdAt) continue;

    const dateKey = getDateKey(createdAt);
    const earningMonthKey = getMonthKey(createdAt);

    if (dateKey === todayKey) {
      summary.today.earningsCents += amountCents;
      summary.today.billableMinutes += minutes;
    }

    if (dateKey >= weekStartKey && dateKey <= todayKey) {
      summary.week.earningsCents += amountCents;
      summary.week.billableMinutes += minutes;
    }

    if (earningMonthKey === monthKey) {
      summary.month.earningsCents += amountCents;
      summary.month.billableMinutes += minutes;
    }
  }

  let completedCallCount = 0;
  let completedCallSeconds = 0;

  for (const document of callsSnapshot.docs) {
    const call = document.data();

    if (call.status !== "completed") continue;

    completedCallCount += 1;

    const seconds = Math.max(
      0,
      Math.floor(toNumber(call.durationSeconds))
    );

    completedCallSeconds += seconds;
  }

  const withdrawalSummary = {
    pendingCents: 0,
    paidCents: 0,
    rejectedCents: 0,
  };

  for (const document of withdrawalsSnapshot.docs) {
    const withdrawal = document.data();
    const amountCents = Math.max(
      0,
      Math.floor(toNumber(withdrawal.amountCents))
    );

    if (withdrawal.status === "pending") {
      withdrawalSummary.pendingCents += amountCents;
    } else if (withdrawal.status === "paid") {
      withdrawalSummary.paidCents += amountCents;
    } else if (withdrawal.status === "rejected") {
      withdrawalSummary.rejectedCents += amountCents;
    }
  }

  return {
    hostId,
    currency: "ZAR",
    ratePerMinute: HOST_RATE_CENTS / 100,

    balance: {
      availableCents: Math.max(
        0,
        Math.floor(toNumber(host.availableHostEarningsCents))
      ),
      available: toZAR(host.availableHostEarningsCents),
      lifetimeEarnedCents: Math.max(
        0,
        Math.floor(toNumber(host.lifetimeHostEarningsCents))
      ),
      lifetimeEarned: toZAR(host.lifetimeHostEarningsCents),
    },

    earnings: {
      today: {
        ...summary.today,
        amount: toZAR(summary.today.earningsCents),
      },
      week: {
        ...summary.week,
        amount: toZAR(summary.week.earningsCents),
      },
      month: {
        ...summary.month,
        amount: toZAR(summary.month.earningsCents),
      },
      allTime: {
        ...summary.allTime,
        amount: toZAR(summary.allTime.earningsCents),
      },
    },

    calls: {
      completed: completedCallCount,
      totalSeconds: completedCallSeconds,
      totalMinutes: Math.floor(completedCallSeconds / 60),
      totalHours: Number(
        (completedCallSeconds / 3600).toFixed(2)
      ),
    },

    withdrawals: {
      pendingCents: withdrawalSummary.pendingCents,
      pending: toZAR(withdrawalSummary.pendingCents),
      paidCents: withdrawalSummary.paidCents,
      paid: toZAR(withdrawalSummary.paidCents),
      rejectedCents: withdrawalSummary.rejectedCents,
      rejected: toZAR(withdrawalSummary.rejectedCents),
    },
  };
}

/*
|--------------------------------------------------------------------------
| CREATE WITHDRAWAL REQUEST
|--------------------------------------------------------------------------
|
| The requested amount is deducted from the available balance inside
| the same Firestore transaction that creates the withdrawal record.
| Concurrent requests therefore cannot reserve the same balance twice.
|
*/

export async function requestHostWithdrawal(
  hostId,
  amountRand,
  bankDetails,
  confirmedCorrect
) {
  if (!hostId) {
    throw new Error("A host ID is required.");
  }

  if (confirmedCorrect !== true) {
    throw new Error("Please confirm that your bank details are correct.");
  }

  const amount = Number(amountRand);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a valid withdrawal amount.");
  }

  const amountCents = Math.round(amount * 100);

  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    Math.abs(amount * 100 - amountCents) > 0.000001
  ) {
    throw new Error("Enter a valid amount in rand and cents.");
  }

  const validatedBankDetails = validateBankDetails(bankDetails);

  const hostRef = hostsCollection.doc(hostId);
  const withdrawalRef = withdrawalsCollection.doc();

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account not found.");
    }

    const host = hostSnapshot.data();

    if (host.status !== "active") {
      throw new Error("Only active hosts can request withdrawals.");
    }

    const availableCents = Math.max(
      0,
      Math.floor(toNumber(host.availableHostEarningsCents))
    );

    if (amountCents > availableCents) {
      throw new Error(
        "Your withdrawal amount exceeds your available earnings."
      );
    }

    transaction.update(hostRef, {
      availableHostEarningsCents: availableCents - amountCents,
      updatedAt: new Date(),
    });

    transaction.create(withdrawalRef, {
      hostId,
      hostFirebaseUid: host.firebaseUid ?? null,
      hostUsername: host.publicUsername ?? host.username ?? null,

      amountCents,
      amount: toZAR(amountCents),
      currency: "ZAR",

      bankDetails: validatedBankDetails,
      bankDetailsConfirmed: true,

      status: "pending",
      payoutMethod: "manual",
      payoutNote: "Awaiting admin payout processing.",

      requestedAt: new Date(),
      updatedAt: new Date(),

      paidAt: null,
      rejectedAt: null,
      reviewedBy: null,
    });
  });

  return {
    withdrawalId: withdrawalRef.id,
    amountCents,
    amount: toZAR(amountCents),
    currency: "ZAR",
    status: "pending",
    message:
      "Your withdrawal request has been submitted. Payout timing will be confirmed by SA LIVE.",
  };
}

/*
|--------------------------------------------------------------------------
| HOST WITHDRAWAL HISTORY
|--------------------------------------------------------------------------
*/

export async function getHostWithdrawalHistory(hostId) {
  if (!hostId) {
    throw new Error("A host ID is required.");
  }

  const snapshot = await withdrawalsCollection
    .where("hostId", "==", hostId)
    .get();

  const withdrawals = snapshot.docs.map((document) => {
    const data = document.data();

    return {
      id: document.id,
      amountCents: Math.max(
        0,
        Math.floor(toNumber(data.amountCents))
      ),
      amount: toZAR(data.amountCents),
      currency: data.currency ?? "ZAR",
      status: data.status ?? "pending",
      payoutMethod: data.payoutMethod ?? "manual",
      payoutNote: data.payoutNote ?? "",
      requestedAt: toDate(data.requestedAt)?.toISOString() ?? null,
      updatedAt: toDate(data.updatedAt)?.toISOString() ?? null,
      paidAt: toDate(data.paidAt)?.toISOString() ?? null,
      rejectedAt: toDate(data.rejectedAt)?.toISOString() ?? null,
    };
  });

  withdrawals.sort((a, b) => {
    return (
      new Date(b.requestedAt ?? 0).getTime() -
      new Date(a.requestedAt ?? 0).getTime()
    );
  });

  return withdrawals;
}
