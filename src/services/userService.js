
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

// ============================================================
// HELPERS
// ============================================================

function toUser(doc) {
  return {
    id: doc.id,
    ...doc.data(),
  };
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error("Invalid user minute balance.");
  }

  return minutes;
}

function normalizeTelegramId(telegramId) {
  if (
    telegramId === undefined ||
    telegramId === null ||
    !/^\d+$/.test(String(telegramId))
  ) {
    throw new Error("A valid Telegram ID is required.");
  }

  return String(telegramId);
}

function normalizeEmail(email) {
  if (typeof email !== "string") {
    throw new Error("A valid email address is required.");
  }

  const normalized = email.trim().toLowerCase();

  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("A valid email address is required.");
  }

  return normalized;
}

function normalizeGmail(email) {
  const normalized = normalizeEmail(email);

  if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(normalized)) {
    throw new Error(
      "Please provide a valid Gmail address ending in @gmail.com."
    );
  }

  return normalized;
}

function requireUserId(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId.includes("/") ||
    userId.includes("\0")
  ) {
    throw new Error("A valid user ID is required.");
  }

  return userId.trim();
}

// ============================================================
// GET USER BY TELEGRAM ID
// ============================================================

export async function getUserByTelegramId(telegramId) {
  const id = normalizeTelegramId(telegramId);

  const snapshot = await usersCollection
    .where("telegramId", "==", id)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return toUser(snapshot.docs[0]);
}

// ============================================================
// CREATE USER
// ============================================================

export async function createUser(telegramUser) {
  if (
    !telegramUser ||
    telegramUser.id === undefined ||
    telegramUser.id === null
  ) {
    throw new Error("A valid Telegram user is required.");
  }

  const telegramId = normalizeTelegramId(telegramUser.id);
  const userRef = usersCollection.doc(`tg_${telegramId}`);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (snapshot.exists) {
      return toUser(snapshot);
    }

    const now = new Date();

    const displayName = [
      telegramUser.first_name,
      telegramUser.last_name,
    ]
      .filter(Boolean)
      .join(" ")
      .trim() || "SA LIVE User";

    const userData = {
      telegramId,
      username: telegramUser.username || null,
      firstName: telegramUser.first_name || "",
      lastName: telegramUser.last_name || "",

      profile: {
        displayName,
        bio: "",
      },

      verificationStatus: "pending",

      verification: {
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },

      // Purchased call minutes only.
      minutes: 0,

      activeCallId: null,
      role: "user",

      // Gmail collected during verification.
      // Reused for PayFast checkout.
      paymentEmail: null,

      pendingPaymentPackageId: null,

      createdAt: now,
      updatedAt: now,
    };

    transaction.create(userRef, userData);

    return {
      id: userRef.id,
      ...userData,
    };
  });
}

// ============================================================
// GET OR CREATE USER
// ============================================================

export async function getOrCreateUser(telegramUser) {
  if (
    !telegramUser ||
    telegramUser.id === undefined ||
    telegramUser.id === null
  ) {
    throw new Error("A valid Telegram user is required.");
  }

  return createUser(telegramUser);
}

// ============================================================
// SUBMIT VERIFICATION
// ============================================================
// Saves Gmail and submits verification atomically.
// ============================================================

export async function submitVerification(userId, email) {
  userId = requireUserId(userId);

  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    const user = snapshot.data();

    if (user.verificationStatus === "approved") {
      return {
        success: true,
        alreadyApproved: true,
        verificationStatus: "approved",
        email: user.paymentEmail || normalizedEmail,
      };
    }

    const now = new Date();

    transaction.update(userRef, {
      paymentEmail: normalizedEmail,

      verificationStatus: "pending",

      "verification.submittedAt": now,
      "verification.reviewedAt": null,
      "verification.reviewedBy": null,
      "verification.rejectionReason": null,

      updatedAt: now,
    });

    return {
      success: true,
      alreadyApproved: false,
      verificationStatus: "pending",
      email: normalizedEmail,
    };
  });
}

// ============================================================
// APPROVE VERIFICATION
// Never grants free minutes.
// ============================================================

export async function approveVerification(userId, adminTelegramId) {
  userId = requireUserId(userId);

  if (
    adminTelegramId === undefined ||
    adminTelegramId === null
  ) {
    throw new Error(
      "User ID and administrator Telegram ID are required."
    );
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    const user = snapshot.data();
    const currentMinutes = normalizeMinutes(user.minutes);

    if (user.verificationStatus === "approved") {
      return {
        alreadyApproved: true,
        verificationStatus: "approved",
        minutes: currentMinutes,
      };
    }

    if (!normalizeGmail(user.paymentEmail)) {
      throw new Error(
        "Cannot approve verification without a saved Gmail address."
      );
    }

    const now = new Date();

    transaction.update(userRef, {
      verificationStatus: "approved",
      "verification.reviewedAt": now,
      "verification.reviewedBy": String(adminTelegramId),
      "verification.rejectionReason": null,
      updatedAt: now,
    });

    return {
      alreadyApproved: false,
      verificationStatus: "approved",
      minutes: currentMinutes,
    };
  });
}

// ============================================================
// REJECT VERIFICATION
// ============================================================

export async function rejectVerification(
  userId,
  adminTelegramId,
  reason = "Verification was not approved."
) {
  userId = requireUserId(userId);

  if (
    adminTelegramId === undefined ||
    adminTelegramId === null
  ) {
    throw new Error(
      "User ID and administrator Telegram ID are required."
    );
  }

  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("A rejection reason is required.");
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    if (snapshot.data().verificationStatus === "approved") {
      throw new Error(
        "An approved user's verification cannot be rejected directly."
      );
    }

    const now = new Date();

    transaction.update(userRef, {
      verificationStatus: "rejected",
      "verification.reviewedAt": now,
      "verification.reviewedBy": String(adminTelegramId),
      "verification.rejectionReason": reason.trim(),
      updatedAt: now,
    });

    return {
      success: true,
      verificationStatus: "rejected",
    };
  });
}

// ============================================================
// GET PENDING USERS
// ============================================================

export async function getPendingUsers() {
  const snapshot = await usersCollection
    .where("verificationStatus", "==", "pending")
    .get();

  const users = snapshot.docs.map(toUser);

  function getTimestamp(value) {
    if (value?.toMillis) {
      return value.toMillis();
    }

    if (value instanceof Date) {
      return value.getTime();
    }

    return 0;
  }

  users.sort((a, b) => {
    return (
      getTimestamp(a.verification?.submittedAt || a.createdAt) -
      getTimestamp(b.verification?.submittedAt || b.createdAt)
    );
  });

  return users;
}

// ============================================================
// GET USER MINUTES
// ============================================================

export async function getUserMinutes(userId) {
  userId = requireUserId(userId);

  const snapshot = await usersCollection.doc(userId).get();

  if (!snapshot.exists) {
    throw new Error("User not found.");
  }

  return normalizeMinutes(snapshot.data().minutes);
}

// ============================================================
// ADD MINUTES
// Only call after verified payment processing.
// ============================================================

export async function addMinutes(userId, minutes) {
  userId = requireUserId(userId);

  const amount = Number(minutes);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      "Minutes to add must be a positive whole number."
    );
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    const currentMinutes = normalizeMinutes(
      snapshot.data().minutes
    );

    const newMinutes = currentMinutes + amount;

    if (!Number.isSafeInteger(newMinutes)) {
      throw new Error(
        "The resulting minute balance is invalid."
      );
    }

    transaction.update(userRef, {
      minutes: newMinutes,
      updatedAt: new Date(),
    });

    return newMinutes;
  });
}

// ============================================================
// DEDUCT MINUTES
// ============================================================

export async function deductMinutes(userId, minutes) {
  userId = requireUserId(userId);

  const amount = Number(minutes);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      "Minutes to deduct must be a positive whole number."
    );
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    const currentMinutes = normalizeMinutes(
      snapshot.data().minutes
    );

    if (currentMinutes < amount) {
      throw new Error("Insufficient available minutes.");
    }

    const newMinutes = currentMinutes - amount;

    transaction.update(userRef, {
      minutes: newMinutes,
      updatedAt: new Date(),
    });

    return newMinutes;
  });
}

// ============================================================
// UPDATE PAYMENT EMAIL
// ============================================================
// Validates and saves a Gmail address.
// ============================================================

export async function updateUserPaymentEmail(userId, email) {
  userId = requireUserId(userId);

  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(userId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    transaction.update(userRef, {
      paymentEmail: normalizedEmail,
      updatedAt: new Date(),
    });
  });

  return {
    success: true,
    email: normalizedEmail,
  };
}

// ============================================================
// GET PAYMENT EMAIL
// Used by PayFast checkout.
// ============================================================

export async function getUserPaymentEmail(userId) {
  userId = requireUserId(userId);

  const snapshot = await usersCollection.doc(userId).get();

  if (!snapshot.exists) {
    throw new Error("User not found.");
  }

  const user = snapshot.data();
  const email = user.paymentEmail ?? user.email ?? null;

  if (email === null || email === "") {
    return null;
  }

  return normalizeGmail(email);
}

// ============================================================
// SET PENDING PAYMENT PACKAGE
// ============================================================

export async function setPendingPaymentPackage(userId, packageId) {
  userId = requireUserId(userId);

  if (
    typeof packageId !== "string" ||
    !packageId.trim()
  ) {
    throw new Error(
      "User ID and a valid package ID are required."
    );
  }

  const normalizedPackageId = packageId.trim();
  const userRef = usersCollection.doc(userId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    transaction.update(userRef, {
      pendingPaymentPackageId: normalizedPackageId,
      updatedAt: new Date(),
    });
  });

  return {
    success: true,
    packageId: normalizedPackageId,
  };
}

// ============================================================
// CLEAR PENDING PAYMENT
// ============================================================

export async function clearPendingPayment(userId) {
  userId = requireUserId(userId);

  const userRef = usersCollection.doc(userId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User not found.");
    }

    transaction.update(userRef, {
      pendingPaymentPackageId: null,
      updatedAt: new Date(),
    });
  });

  return {
    success: true,
  };
}
