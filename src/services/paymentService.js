import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");
const paymentsCollection = db.collection("payments");
const withdrawalsCollection = db.collection("withdrawals");
const earningsCollection = db.collection("hostEarnings");

/*
|--------------------------------------------------------------------------
| SA LIVE PAYMENT RULES
|--------------------------------------------------------------------------
| Customer: R30 per 5 minutes.
| Host: R2 per completed eligible minute.
| Platform: R10 gross per 5 fully completed minutes, before fees.
|
| All monetary values are stored as integer cents internally when
| calculating amounts. Existing package amounts remain in rand.
|--------------------------------------------------------------------------
*/

export const HOST_EARNINGS_PER_MINUTE = 2;
export const CUSTOMER_PRICE_PER_MINUTE = 6;

export const PAYMENT_PACKAGES = {
  starter: {
    id: "starter",
    name: "5 Minutes",
    amount: 30,
    minutes: 5,
  },

  ten_minutes: {
    id: "ten_minutes",
    name: "10 Minutes",
    amount: 60,
    minutes: 10,
  },

  thirty_minutes: {
    id: "thirty_minutes",
    name: "30 Minutes",
    amount: 180,
    minutes: 30,
  },

  sixty_minutes: {
    id: "sixty_minutes",
    name: "60 Minutes",
    amount: 360,
    minutes: 60,
  },

  three_hour: {
    id: "three_hour",
    name: "3 Hours",
    amount: 1080,
    minutes: 180,
  },
};

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function requireString(value, fieldName) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function toSafeNumber(value, fallback = 0) {
  const number = Number(value ?? fallback);

  if (!Number.isFinite(number)) {
    throw new Error("A stored financial or balance value is invalid.");
  }

  return number;
}

/*
|--------------------------------------------------------------------------
| GET PACKAGE
|--------------------------------------------------------------------------
*/

export function getPaymentPackage(packageId) {
  if (typeof packageId !== "string") {
    return null;
  }

  return PAYMENT_PACKAGES[packageId] ?? null;
}

/*
|--------------------------------------------------------------------------
| CREATE PENDING PAYMENT
|--------------------------------------------------------------------------
| Create this record before redirecting the customer to PayFast.
| The server must establish the authenticated userId.
| Never credit minutes based only on a browser redirect.
|--------------------------------------------------------------------------
*/

export async function createPaymentRecord({
  userId,
  reference,
  packageId,
  email,
}) {
  userId = requireString(userId, "User ID");
  reference = requireString(reference, "Payment reference");

  const paymentPackage = getPaymentPackage(packageId);

  if (!paymentPackage) {
    throw new Error("Invalid payment package.");
  }

  if (
    email !== undefined &&
    email !== null &&
    (
      typeof email !== "string" ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
  ) {
    throw new Error("A valid payment email is required.");
  }

  const userRef = usersCollection.doc(userId);
  const paymentRef = paymentsCollection.doc(reference);

  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    const existingPayment = await transaction.get(paymentRef);

    if (!userSnapshot.exists) {
      throw new Error("User account was not found.");
    }

    if (existingPayment.exists) {
      throw new Error("Payment reference already exists.");
    }

    transaction.create(paymentRef, {
      userId,
      reference,
      packageId: paymentPackage.id,
      packageName: paymentPackage.name,
      amount: paymentPackage.amount,
      amountCents: Math.round(paymentPackage.amount * 100),
      currency: "ZAR",
      minutes: paymentPackage.minutes,
      email: email ? email.trim().toLowerCase() : null,

      provider: "payfast",
      status: "pending",
      credited: false,

      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  return {
    reference,
    package: paymentPackage,
  };
}

/*
|--------------------------------------------------------------------------
| GET PAYMENT BY REFERENCE
|--------------------------------------------------------------------------
*/

export async function getPaymentByReference(reference) {
  if (
    typeof reference !== "string" ||
    reference.trim().length === 0
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

/*
|--------------------------------------------------------------------------
| CREDIT VERIFIED PAYMENT ONCE
|--------------------------------------------------------------------------
| Call ONLY after the PayFast ITN has been verified, including:
| - Signature verification
| - PayFast server validation
| - Payment status
| - Merchant identity
| - Expected amount and currency
|
| The PayFast integration must perform these checks before calling
| this function. Duplicate notifications must not credit twice.
|--------------------------------------------------------------------------
*/

export async function creditSuccessfulPayment(reference) {
  reference = requireString(reference, "Payment reference");

  const paymentRef = paymentsCollection.doc(reference);

  return db.runTransaction(async (transaction) => {
    const paymentSnapshot = await transaction.get(paymentRef);

    if (!paymentSnapshot.exists) {
      throw new Error("Payment record was not found.");
    }

    const payment = paymentSnapshot.data();

    if (payment.credited === true) {
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
      !validPositiveInteger(payment.minutes) ||
      !validPositiveInteger(payment.amountCents) ||
      payment.currency !== "ZAR" ||
      payment.provider !== "payfast"
    ) {
      throw new Error("Payment record is invalid.");
    }

    const userRef = usersCollection.doc(payment.userId);
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("User account was not found.");
    }

    const currentMinutes = toSafeNumber(
      userSnapshot.get("minutes"),
      0
    );

    if (
      !Number.isSafeInteger(currentMinutes) ||
      currentMinutes < 0
    ) {
      throw new Error("User minute balance is invalid.");
    }

    transaction.update(userRef, {
      minutes: currentMinutes + payment.minutes,
      updatedAt: new Date(),
    });

    transaction.update(paymentRef, {
      status: "complete",
      credited: true,
      creditedAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      success: true,
      alreadyCredited: false,
      minutes: payment.minutes,
    };
  });
}

/*
|--------------------------------------------------------------------------
| RECORD HOST EARNINGS FOR COMPLETED MINUTES
|--------------------------------------------------------------------------
| This function is intended to be called by the trusted backend after
| a call has ended and the eligible completed minutes are confirmed.
|
| Each call must have a stable, unique callId.
| A host cannot earn twice for the same callId.
|
| IMPORTANT:
| Do not expose this function directly through an unauthenticated
| endpoint or allow hosts to choose their own completed-minute count.
|--------------------------------------------------------------------------
*/

export async function recordHostEarnings({
  hostId,
  callId,
  completedMinutes,
}) {
  hostId = requireString(hostId, "Host ID");
  callId = requireString(callId, "Call ID");

  if (!validPositiveInteger(completedMinutes)) {
    throw new Error(
      "Completed minutes must be a positive whole number."
    );
  }

  const hostRef = usersCollection.doc(hostId);
  const earningRef = earningsCollection.doc(callId);

  const amountCents =
    completedMinutes *
    HOST_EARNINGS_PER_MINUTE *
    100;

  if (!Number.isSafeInteger(amountCents)) {
    throw new Error("Host earnings amount is invalid.");
  }

  return db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);
    const earningSnapshot = await transaction.get(earningRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    if (earningSnapshot.exists) {
      const existingEarning = earningSnapshot.data();

      if (existingEarning.hostId !== hostId) {
        throw new Error(
          "This call ID is already associated with another host."
        );
      }

      return {
        success: true,
        alreadyRecorded: true,
        completedMinutes: existingEarning.completedMinutes,
        amount: existingEarning.amount,
      };
    }

    const currentAvailableCents = Math.round(
      toSafeNumber(
        hostSnapshot.get("availableHostEarningsCents"),
        0
      )
    );

    const currentLifetimeCents = Math.round(
      toSafeNumber(
        hostSnapshot.get("lifetimeHostEarningsCents"),
        0
      )
    );

    if (
      !Number.isSafeInteger(currentAvailableCents) ||
      !Number.isSafeInteger(currentLifetimeCents) ||
      currentAvailableCents < 0 ||
      currentLifetimeCents < 0
    ) {
      throw new Error("Host earnings balance is invalid.");
    }

    transaction.create(earningRef, {
      callId,
      hostId,
      completedMinutes,
      ratePerMinute: HOST_EARNINGS_PER_MINUTE,
      amount: amountCents / 100,
      amountCents,
      currency: "ZAR",
      status: "available",
      createdAt: new Date(),
    });

    transaction.update(hostRef, {
      availableHostEarningsCents:
        currentAvailableCents + amountCents,

      lifetimeHostEarningsCents:
        currentLifetimeCents + amountCents,

      updatedAt: new Date(),
    });

    return {
      success: true,
      alreadyRecorded: false,
      completedMinutes,
      amount: amountCents / 100,
    };
  });
}

/*
|--------------------------------------------------------------------------
| GET HOST EARNINGS SUMMARY
|--------------------------------------------------------------------------
*/

export async function getHostEarningsSummary(hostId) {
  hostId = requireString(hostId, "Host ID");

  const hostSnapshot = await usersCollection
    .doc(hostId)
    .get();

  if (!hostSnapshot.exists) {
    throw new Error("Host account was not found.");
  }

  const host = hostSnapshot.data();

  const availableCents = Math.round(
    toSafeNumber(host.availableHostEarningsCents, 0)
  );

  const lifetimeCents = Math.round(
    toSafeNumber(host.lifetimeHostEarningsCents, 0)
  );

  if (
    !Number.isSafeInteger(availableCents) ||
    !Number.isSafeInteger(lifetimeCents) ||
    availableCents < 0 ||
    lifetimeCents < 0
  ) {
    throw new Error("Host earnings balance is invalid.");
  }

  return {
    hostId,
    currency: "ZAR",
    available: availableCents / 100,
    lifetime: lifetimeCents / 100,
  };
}

/*
|--------------------------------------------------------------------------
| CREATE HOST WITHDRAWAL REQUEST
|--------------------------------------------------------------------------
| Creates a request for administrator review.
| This function does NOT transfer money.
|
| The caller must authenticate the host and derive hostId from the
| verified session, not accept an arbitrary hostId from the client.
|--------------------------------------------------------------------------
*/

export async function createHostWithdrawalRequest({
  hostId,
  amount,
  bankDetails,
}) {
  hostId = requireString(hostId, "Host ID");

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.round(amount * 100) !== amount * 100
  ) {
    throw new Error(
      "Withdrawal amount must be a positive rand amount with at most two decimal places."
    );
  }

  if (
    !bankDetails ||
    typeof bankDetails !== "object" ||
    Array.isArray(bankDetails)
  ) {
    throw new Error("Bank details are required.");
  }

  const accountHolder = requireString(
    bankDetails.accountHolder,
    "Account holder"
  );

  const bankName = requireString(
    bankDetails.bankName,
    "Bank name"
  );

  const accountNumber = requireString(
    bankDetails.accountNumber,
    "Account number"
  );

  const accountType = requireString(
    bankDetails.accountType,
    "Account type"
  );

  if (
    accountHolder.length > 120 ||
    bankName.length > 120 ||
    accountNumber.length > 40 ||
    !/^[a-zA-Z0-9 -]+$/.test(accountNumber) ||
    accountType.length > 60
  ) {
    throw new Error("Bank details are invalid.");
  }

  const amountCents = Math.round(amount * 100);

  const hostRef = usersCollection.doc(hostId);
  const withdrawalRef = withdrawalsCollection.doc();

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const host = hostSnapshot.data();

    const availableCents = Math.round(
      toSafeNumber(host.availableHostEarningsCents, 0)
    );

    const reservedCents = Math.round(
      toSafeNumber(host.pendingHostWithdrawalsCents, 0)
    );

    if (
      !Number.isSafeInteger(availableCents) ||
      !Number.isSafeInteger(reservedCents) ||
      availableCents < 0 ||
      reservedCents < 0
    ) {
      throw new Error("Host withdrawal balance is invalid.");
    }

    if (amountCents > availableCents) {
      throw new Error("Insufficient available host earnings.");
    }

    transaction.create(withdrawalRef, {
      hostId,
      amount,
      amountCents,
      currency: "ZAR",

      bankDetails: {
        accountHolder,
        bankName,
        accountNumber,
        accountType,
      },

      status: "pending",
      payoutMethod: "manual",
      adminNotified: false,

      createdAt: new Date(),
      updatedAt: new Date(),
    });

    transaction.update(hostRef, {
      availableHostEarningsCents:
        availableCents - amountCents,

      pendingHostWithdrawalsCents:
        reservedCents + amountCents,

      updatedAt: new Date(),
    });
  });

  return {
    success: true,
    withdrawalId: withdrawalRef.id,
    amount,
    currency: "ZAR",
    status: "pending",
  };
}

/*
|--------------------------------------------------------------------------
| ADMINISTRATOR MARKS A WITHDRAWAL AS PAID
|--------------------------------------------------------------------------
| Call only from a properly authenticated and authorized admin route
| after confirming that the bank transfer actually succeeded.
|
| This marks the withdrawal paid. It does not initiate a transfer.
|--------------------------------------------------------------------------
*/

export async function markHostWithdrawalPaid({
  withdrawalId,
  adminId,
  payoutReference,
}) {
  withdrawalId = requireString(
    withdrawalId,
    "Withdrawal ID"
  );

  adminId = requireString(adminId, "Administrator ID");

  if (
    payoutReference !== undefined &&
    payoutReference !== null &&
    (
      typeof payoutReference !== "string" ||
      payoutReference.trim().length > 200
    )
  ) {
    throw new Error("Payout reference is invalid.");
  }

  const withdrawalRef =
    withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot =
      await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request was not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

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

    const hostRef = usersCollection.doc(withdrawal.hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const pendingCents = Math.round(
      toSafeNumber(
        hostSnapshot.get("pendingHostWithdrawalsCents"),
        0
      )
    );

    if (
      !Number.isSafeInteger(pendingCents) ||
      pendingCents < withdrawal.amountCents
    ) {
      throw new Error(
        "Pending withdrawal balance does not match the request."
      );
    }

    transaction.update(hostRef, {
      pendingHostWithdrawalsCents:
        pendingCents - withdrawal.amountCents,

      updatedAt: new Date(),
    });

    transaction.update(withdrawalRef, {
      status: "paid",
      payoutMethod: "manual",
      payoutReference: payoutReference
        ? payoutReference.trim()
        : null,
      processedBy: adminId,
      paidAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      success: true,
      alreadyPaid: false,
      withdrawalId,
      amount: withdrawal.amount,
    };
  });
}

/*
|--------------------------------------------------------------------------
| ADMINISTRATOR REJECTS A WITHDRAWAL
|--------------------------------------------------------------------------
| Releases the reserved amount back to the host's available balance.
|--------------------------------------------------------------------------
*/

export async function rejectHostWithdrawal({
  withdrawalId,
  adminId,
  reason,
}) {
  withdrawalId = requireString(
    withdrawalId,
    "Withdrawal ID"
  );

  adminId = requireString(adminId, "Administrator ID");

  if (
    typeof reason !== "string" ||
    reason.trim().length === 0 ||
    reason.trim().length > 500
  ) {
    throw new Error(
      "A rejection reason of up to 500 characters is required."
    );
  }

  const withdrawalRef =
    withdrawalsCollection.doc(withdrawalId);

  return db.runTransaction(async (transaction) => {
    const withdrawalSnapshot =
      await transaction.get(withdrawalRef);

    if (!withdrawalSnapshot.exists) {
      throw new Error("Withdrawal request was not found.");
    }

    const withdrawal = withdrawalSnapshot.data();

    if (withdrawal.status !== "pending") {
      throw new Error(
        "Only pending withdrawals can be rejected."
      );
    }

    const hostRef = usersCollection.doc(withdrawal.hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account was not found.");
    }

    const host = hostSnapshot.data();

    const availableCents = Math.round(
      toSafeNumber(host.availableHostEarningsCents, 0)
    );

    const pendingCents = Math.round(
      toSafeNumber(host.pendingHostWithdrawalsCents, 0)
    );

    if (
      !Number.isSafeInteger(availableCents) ||
      !Number.isSafeInteger(pendingCents) ||
      availableCents < 0 ||
      pendingCents < withdrawal.amountCents
    ) {
      throw new Error(
        "Host withdrawal balances are invalid."
      );
    }

    transaction.update(hostRef, {
      availableHostEarningsCents:
        availableCents + withdrawal.amountCents,

      pendingHostWithdrawalsCents:
        pendingCents - withdrawal.amountCents,

      updatedAt: new Date(),
    });

    transaction.update(withdrawalRef, {
      status: "rejected",
      rejectionReason: reason.trim(),
      processedBy: adminId,
      rejectedAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      success: true,
      withdrawalId,
      status: "rejected",
    };
  });
}