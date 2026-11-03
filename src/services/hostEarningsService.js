
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const earningsCollection = db.collection("hostEarnings");
const callsCollection = db.collection("callSessions");
const withdrawalsCollection = db.collection("hostWithdrawals");

const HOST_RATE_CENTS = 200;
const TIME_ZONE = "Africa/Johannesburg";

const VALID_WITHDRAWAL_STATUSES = new Set([
  "pending",
  "paid",
  "rejected",
]);

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeId(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 256 ||
    value.trim().includes("/")
  ) {
    throw makeError(`Invalid ${label}.`, 400);
  }

  return value.trim();
}

function toNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function validCents(value, label = "Amount") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw makeError(
      `${label} must be a valid non-negative amount in cents.`,
      500
    );
  }

  return value;
}

function toZAR(cents) {
  return Number(
    (validCents(cents) / 100).toFixed(2)
  );
}

function toDate(value) {
  if (!value) return null;

  try {
    if (typeof value.toDate === "function") {
      return value.toDate();
    }

    const date =
      value instanceof Date ? value : new Date(value);

    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
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

  const weekday = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day)
    )
  ).getUTCDay();

  const daysSinceMonday = (weekday + 6) % 7;

  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day) - daysSinceMonday
    )
  )
    .toISOString()
    .slice(0, 10);
}

function getMonthKey(date) {
  const parts = getSouthAfricanDateParts(date);

  return `${parts.year}-${parts.month}`;
}

function parseRandToCents(value) {
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    throw makeError("Enter a valid withdrawal amount.", 400);
  }

  const text = String(value).trim();

  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw makeError(
      "Enter a valid amount in rand and cents.",
      400
    );
  }

  const [rand, cents = ""] = text.split(".");
  const amountCents =
    Number(rand) * 100 +
    Number(cents.padEnd(2, "0"));

  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0
  ) {
    throw makeError(
      "Enter a valid withdrawal amount.",
      400
    );
  }

  return amountCents;
}

function validateBankDetails(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw makeError("Bank details are required.", 400);
  }

  const details = {
    accountHolder:
      typeof input.accountHolder === "string"
        ? input.accountHolder.trim()
        : "",
    bankName:
      typeof input.bankName === "string"
        ? input.bankName.trim()
        : "",
    accountNumber:
      typeof input.accountNumber === "string"
        ? input.accountNumber.trim()
        : "",
    accountType:
      typeof input.accountType === "string"
        ? input.accountType.trim().toLowerCase()
        : "",
    branchCode:
      typeof input.branchCode === "string"
        ? input.branchCode.trim()
        : "",
  };

  if (
    details.accountHolder.length < 2 ||
    details.accountHolder.length > 100
  ) {
    throw makeError(
      "Enter a valid account holder name.",
      400
    );
  }

  if (
    details.bankName.length < 2 ||
    details.bankName.length > 100
  ) {
    throw makeError("Enter a valid bank name.", 400);
  }

  if (!/^[0-9]{6,20}$/.test(details.accountNumber)) {
    throw makeError(
      "Enter an account number containing 6–20 digits.",
      400
    );
  }

  if (
    !["savings", "current", "cheque", "transmission"].includes(
      details.accountType
    )
  ) {
    throw makeError(
      "Choose savings, current, cheque, or transmission as the account type.",
      400
    );
  }

  if (
    details.branchCode.length > 20 ||
    (
      details.branchCode &&
      !/^[a-zA-Z0-9 -]+$/.test(details.branchCode)
    )
  ) {
    throw makeError(
      "Enter a valid branch code.",
      400
    );
  }

  return details;
}

function getEarningAmountCents(earning) {
  if (
    Number.isSafeInteger(earning.amountCents) &&
    earning.amountCents >= 0
  ) {
    return earning.amountCents;
  }

  if (
    earning.amount !== undefined &&
    Number.isFinite(Number(earning.amount)) &&
    Number(earning.amount) >= 0
  ) {
    return Math.round(Number(earning.amount) * 100);
  }

  const minutes = Number(
    earning.completedMinutes ?? 0
  );

  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 0
  ) {
    return 0;
  }

  return minutes * HOST_RATE_CENTS;
}

// ============================================================
// HOST EARNINGS SUMMARY
// ============================================================

export async function getHostEarningsSummary(hostId) {
  const id = normalizeId(hostId, "host ID");

  const hostSnapshot = await hostsCollection.doc(id).get();

  if (!hostSnapshot.exists) {
    throw makeError("Host account not found.", 404);
  }

  const [
    earningsSnapshot,
    callsSnapshot,
    withdrawalsSnapshot,
  ] = await Promise.all([
    earningsCollection.where("hostId", "==", id).get(),
    callsCollection.where("hostId", "==", id).get(),
    withdrawalsCollection.where("hostId", "==", id).get(),
  ]);

  const host = hostSnapshot.data();

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
    const minutes = Number(
      earning.completedMinutes ?? 0
    );

    if (
      !Number.isSafeInteger(minutes) ||
      minutes < 0
    ) {
      continue;
    }

    summary.allTime.earningsCents += amountCents;
    summary.allTime.billableMinutes += minutes;

    const createdAt = toDate(earning.createdAt);

    if (!createdAt) continue;

    const dateKey = getDateKey(createdAt);
    const earningMonthKey = getMonthKey(createdAt);

    if (dateKey === todayKey) {
      summary.today.earningsCents += amountCents;
      summary.today.billableMinutes += minutes;
    }

    if (
      dateKey >= weekStartKey &&
      dateKey <= todayKey
    ) {
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

    completedCallSeconds += Math.max(
      0,
      Math.floor(toNumber(call.durationSeconds))
    );
  }

  const withdrawalSummary = {
    pendingCents: 0,
    paidCents: 0,
    rejectedCents: 0,
  };

  for (const document of withdrawalsSnapshot.docs) {
    const withdrawal = document.data();

    const amountCents = validCents(
      Math.floor(toNumber(withdrawal.amountCents)),
      "Withdrawal amount"
    );

    if (withdrawal.status === "pending") {
      withdrawalSummary.pendingCents += amountCents;
    } else if (withdrawal.status === "paid") {
      withdrawalSummary.paidCents += amountCents;
    } else if (withdrawal.status === "rejected") {
      withdrawalSummary.rejectedCents += amountCents;
    }
  }

  const availableCents = validCents(
    Math.floor(toNumber(host.availableHostEarningsCents)),
    "Available balance"
  );

  const lifetimeCents = validCents(
    Math.floor(toNumber(host.lifetimeHostEarningsCents)),
    "Lifetime earnings"
  );

  return {
    hostId: id,
    currency: "ZAR",
    ratePerMinute: HOST_RATE_CENTS / 100,

    balance: {
      availableCents,
      available: toZAR(availableCents),
      lifetimeEarnedCents: lifetimeCents,
      lifetimeEarned: toZAR(lifetimeCents),
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
      totalMinutes: Math.floor(
        completedCallSeconds / 60
      ),
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

// ============================================================
// REQUEST HOST WITHDRAWAL
// ============================================================

export async function requestHostWithdrawal(
  hostId,
  amountRand,
  bankDetails,
  confirmedCorrect
) {
  const id = normalizeId(hostId, "host ID");

  if (confirmedCorrect !== true) {
    throw makeError(
      "Please confirm that your bank details are correct.",
      400
    );
  }

  const amountCents = parseRandToCents(amountRand);
  const validatedBankDetails =
    validateBankDetails(bankDetails);

  const hostRef = hostsCollection.doc(id);
  const withdrawalRef = withdrawalsCollection.doc();

  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw makeError(
        "Host account not found.",
        404
      );
    }

    const host = hostSnapshot.data();

    if (host.status !== "active") {
      throw makeError(
        "Only active hosts can request withdrawals.",
        403
      );
    }

    const availableCents = validCents(
      Math.floor(
        toNumber(host.availableHostEarningsCents)
      ),
      "Available balance"
    );

    if (amountCents > availableCents) {
      throw makeError(
        "Your withdrawal amount exceeds your available earnings.",
        400
      );
    }

    // Reserve the money and create the request atomically.
    transaction.update(hostRef, {
      availableHostEarningsCents:
        availableCents - amountCents,
      updatedAt: now,
    });

    transaction.create(withdrawalRef, {
      hostId: id,
      hostFirebaseUid: host.firebaseUid ?? null,
      hostUsername:
        host.publicUsername ??
        host.username ??
        null,

      amountCents,
      amount: toZAR(amountCents),
      currency: "ZAR",

      bankDetails: validatedBankDetails,
      bankDetailsConfirmed: true,

      status: "pending",
      payoutMethod: "manual",
      payoutNote: "Awaiting admin payout processing.",

      requestedAt: now,
      updatedAt: now,
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

// ============================================================
// HOST WITHDRAWAL HISTORY
// ============================================================

export async function getHostWithdrawalHistory(hostId) {
  const id = normalizeId(hostId, "host ID");

  const snapshot = await withdrawalsCollection
    .where("hostId", "==", id)
    .get();

  const withdrawals = snapshot.docs.map((document) => {
    const data = document.data();

    const amountCents = validCents(
      Math.floor(toNumber(data.amountCents)),
      "Withdrawal amount"
    );

    return {
      id: document.id,
      amountCents,
      amount: toZAR(amountCents),
      currency: data.currency ?? "ZAR",
      status: VALID_WITHDRAWAL_STATUSES.has(data.status)
        ? data.status
        : "pending",
      payoutMethod: data.payoutMethod ?? "manual",
      payoutNote: data.payoutNote ?? "",
      requestedAt:
        toDate(data.requestedAt)?.toISOString() ?? null,
      updatedAt:
        toDate(data.updatedAt)?.toISOString() ?? null,
      paidAt:
        toDate(data.paidAt)?.toISOString() ?? null,
      rejectedAt:
        toDate(data.rejectedAt)?.toISOString() ?? null,
    };
  });

  withdrawals.sort(
    (a, b) =>
      new Date(b.requestedAt ?? 0).getTime() -
      new Date(a.requestedAt ?? 0).getTime()
  );

  return withdrawals;
}


// ============================================================
// READ-ONLY HOST EARNINGS DIAGNOSTIC
// Does not modify balances, earnings or withdrawals.
// ============================================================

export async function getHostEarningsDiagnostic(hostId) {
  const id = normalizeId(hostId, "host ID");

  const hostRef = hostsCollection.doc(id);

  const [
    hostSnapshot,
    earningsSnapshot,
    hostWithdrawalsSnapshot,
    legacyWithdrawalsSnapshot,
  ] = await Promise.all([
    hostRef.get(),
    earningsCollection.where("hostId", "==", id).get(),
    withdrawalsCollection.where("hostId", "==", id).get(),
    db.collection("withdrawals").where("hostId", "==", id).get(),
  ]);

  if (!hostSnapshot.exists) {
    throw makeError("Host account not found.", 404);
  }

  const host = hostSnapshot.data();

  let ledgerTotalCents = 0;

  const earnings = earningsSnapshot.docs.map((document) => {
    const data = document.data();
    const amountCents = getEarningAmountCents(data);

    ledgerTotalCents += amountCents;

    return {
      recordId: document.id,
      amountCents,
      amount: toZAR(amountCents),
      createdAt:
        toDate(data.createdAt)?.toISOString() ?? null,
      callId: data.callId ?? document.id,
      billingStatus: data.billingStatus ?? null,
    };
  });

  function summarizeWithdrawals(snapshot) {
    const summary = {
      count: snapshot.size,
      pendingCents: 0,
      paidCents: 0,
      rejectedCents: 0,
      otherCents: 0,
    };

    for (const document of snapshot.docs) {
      const data = document.data();
      const amount = Math.max(
        0,
        Math.floor(toNumber(data.amountCents))
      );

      if (data.status === "pending") {
        summary.pendingCents += amount;
      } else if (data.status === "paid") {
        summary.paidCents += amount;
      } else if (data.status === "rejected") {
        summary.rejectedCents += amount;
      } else {
        summary.otherCents += amount;
      }
    }

    return summary;
  }

  return {
    hostId: id,

    hostBalance: {
      availableCents: Math.floor(
        toNumber(host.availableHostEarningsCents)
      ),
      lifetimeCents: Math.floor(
        toNumber(host.lifetimeHostEarningsCents)
      ),
    },

    earningsLedger: {
      recordCount: earnings.length,
      totalCents: ledgerTotalCents,
      totalRand: toZAR(ledgerTotalCents),
      records: earnings,
    },

    hostWithdrawals: summarizeWithdrawals(
      hostWithdrawalsSnapshot
    ),

    legacyWithdrawals: summarizeWithdrawals(
      legacyWithdrawalsSnapshot
    ),

    diagnosticGeneratedAt: new Date().toISOString(),
  };
}

