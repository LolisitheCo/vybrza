
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

const MAX_UID_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_PHOTO_URL_LENGTH = 2048;
const MAX_PACKAGE_ID_LENGTH = 100;

// ============================================================
// ERROR HELPERS
// ============================================================

function makeError(message, status = 400, code = undefined) {
  const error = new Error(message);
  error.status = status;

  if (code) {
    error.code = code;
  }

  return error;
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

function requireUserId(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId.trim().length > MAX_UID_LENGTH ||
    userId.includes("/") ||
    userId.includes("\0") ||
    /[\u0000-\u001F\u007F]/.test(userId)
  ) {
    throw makeError(
      "A valid Firebase user ID is required.",
      400,
      "INVALID_USER_ID"
    );
  }

  return userId.trim();
}

function normalizeMinutes(value) {
  if (
    !Number.isSafeInteger(value ?? 0) ||
    (value ?? 0) < 0
  ) {
    throw makeError(
      "Invalid user minute balance.",
      500,
      "INVALID_MINUTE_BALANCE"
    );
  }

  return value ?? 0;
}

function normalizeEmail(email) {
  if (
    typeof email !== "string" ||
    email.length > MAX_EMAIL_LENGTH
  ) {
    throw makeError(
      "A valid email address is required.",
      400,
      "INVALID_EMAIL"
    );
  }

  const normalized = email.trim().toLowerCase();

  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      normalized
    )
  ) {
    throw makeError(
      "A valid email address is required.",
      400,
      "INVALID_EMAIL"
    );
  }

  return normalized;
}

function normalizeGmail(email) {
  const normalized = normalizeEmail(email);

  if (
    !/^[a-z0-9._%+-]+@gmail\.com$/i.test(normalized)
  ) {
    throw makeError(
      "Please use a valid Gmail address ending in @gmail.com.",
      400,
      "GMAIL_REQUIRED"
    );
  }

  return normalized;
}

function toUser(snapshot) {
  if (!snapshot?.exists) return null;

  return {
    ...snapshot.data(),
    id: snapshot.id,
  };
}

function getFirebaseEmail(firebaseUser) {
  if (
    typeof firebaseUser?.email !== "string" ||
    !firebaseUser.email.trim()
  ) {
    return null;
  }

  try {
    return normalizeEmail(firebaseUser.email);
  } catch {
    return null;
  }
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return "SA LIVE User";
  }

  return value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) ||
    "SA LIVE User";
}

function normalizePhotoURL(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > MAX_PHOTO_URL_LENGTH
  ) {
    return null;
  }

  try {
    const parsed = new URL(value.trim());

    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizePackageId(packageId) {
  if (
    typeof packageId !== "string" ||
    !packageId.trim() ||
    packageId.trim().length > MAX_PACKAGE_ID_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(packageId)
  ) {
    throw makeError(
      "A valid package ID is required.",
      400,
      "INVALID_PACKAGE_ID"
    );
  }

  return packageId.trim();
}

// ============================================================
// GET WEBSITE USER BY FIREBASE UID
// ============================================================

export async function getUserById(userId) {
  const uid = requireUserId(userId);

  const snapshot = await usersCollection
    .doc(uid)
    .get();

  return toUser(snapshot);
}

export async function getUserByUid(uid) {
  return getUserById(uid);
}

// ============================================================
// GET OR CREATE WEBSITE USER
// ============================================================

/**
 * Call only with an identity obtained from verified
 * Firebase Authentication.
 *
 * Existing account balances, roles, account status and
 * payment information are never overwritten here.
 */

export async function getOrCreateUser(firebaseUser) {
  if (
    !firebaseUser ||
    typeof firebaseUser !== "object"
  ) {
    throw makeError(
      "An authenticated Firebase user is required.",
      401,
      "AUTHENTICATION_REQUIRED"
    );
  }

  const uid = requireUserId(firebaseUser.uid);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (snapshot.exists) {
      const existingUser = toUser(snapshot);

      // A deleted account is a permanent tombstone. Never recreate or
      // reactivate its website profile during a normal login/sync flow.
      if (existingUser.accountStatus === "deleted") {
        throw makeError(
          "This account has been deactivated. Contact support if you believe this is a mistake.",
          403,
          "ACCOUNT_DELETED"
        );
      }

      return existingUser;
    }

    const email = getFirebaseEmail(firebaseUser);
    const now = new Date();

    const displayName = normalizeDisplayName(
      firebaseUser.displayName
    );

    const photoURL = normalizePhotoURL(
      firebaseUser.photoURL
    );

    const userData = {
      uid,
      email,
      paymentEmail: null,

      profile: {
        displayName,
        bio: "",
        photoURL,
      },

      minutes: 0,
      activeCallId: null,

      role: "user",
      accountStatus: "active",

      createdAt: now,
      updatedAt: now,
    };

    transaction.create(userRef, userData);

    return {
      id: uid,
      ...userData,
    };
  });
}

// ============================================================
// GET USER MINUTES
// ============================================================

export async function getUserMinutes(userId) {
  const uid = requireUserId(userId);

  const snapshot = await usersCollection
    .doc(uid)
    .get();

  if (!snapshot.exists) {
    throw makeError(
      "User account not found.",
      404,
      "USER_NOT_FOUND"
    );
  }

  return normalizeMinutes(snapshot.data().minutes);
}

// ============================================================
// ADD MINUTES
// ============================================================

/**
 * IMPORTANT:
 *
 * This function is not independently idempotent.
 *
 * Only call it after verified payment processing.
 * The payment service must prevent the same payment
 * from crediting minutes more than once.
 */

export async function addMinutes(userId, minutes) {
  const uid = requireUserId(userId);

  if (
    !Number.isSafeInteger(minutes) ||
    minutes <= 0
  ) {
    throw makeError(
      "Minutes to add must be a positive whole number.",
      400,
      "INVALID_MINUTES"
    );
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError(
        "User account not found.",
        404,
        "USER_NOT_FOUND"
      );
    }

    const user = snapshot.data();

    if (user.accountStatus === "suspended") {
      throw makeError(
        "This account cannot receive additional minutes.",
        403,
        "ACCOUNT_SUSPENDED"
      );
    }

    const current = normalizeMinutes(user.minutes);
    const updated = current + minutes;

    if (!Number.isSafeInteger(updated)) {
      throw makeError(
        "The resulting minute balance is invalid.",
        500,
        "INVALID_MINUTE_BALANCE"
      );
    }

    transaction.update(userRef, {
      minutes: updated,
      updatedAt: new Date(),
    });

    return updated;
  });
}

// ============================================================
// DEDUCT MINUTES — PARTIAL-SECOND SAFE
// ============================================================

export async function deductMinutes(userId, minutes) {
  const uid = requireUserId(userId);

  if (
    !Number.isSafeInteger(minutes) ||
    minutes <= 0
  ) {
    throw makeError(
      "Minutes to deduct must be a positive whole number.",
      400,
      "INVALID_MINUTES"
    );
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError(
        "User account not found.",
        404,
        "USER_NOT_FOUND"
      );
    }

    const user = snapshot.data();

    const currentMinutes = normalizeMinutes(user.minutes);

    const currentRemainder =
      user.secondsUsedRemainder ?? 0;

    if (
      !Number.isSafeInteger(currentRemainder) ||
      currentRemainder < 0 ||
      currentRemainder > 59
    ) {
      throw makeError(
        "Invalid customer seconds remainder.",
        409,
        "INVALID_SECONDS_REMAINDER"
      );
    }

    const availableSeconds =
      currentMinutes * 60 - currentRemainder;

    const deductionSeconds = minutes * 60;

    if (
      !Number.isSafeInteger(availableSeconds) ||
      availableSeconds < 0
    ) {
      throw makeError(
        "Invalid customer available balance.",
        409,
        "INVALID_MINUTE_BALANCE"
      );
    }

    if (availableSeconds < deductionSeconds) {
      throw makeError(
        "Insufficient available minutes.",
        409,
        "INSUFFICIENT_MINUTES"
      );
    }

    const remainingSeconds =
      availableSeconds - deductionSeconds;

    const updatedMinutes =
      Math.ceil(remainingSeconds / 60);

    const updatedRemainder =
      updatedMinutes * 60 - remainingSeconds;

    transaction.update(userRef, {
      minutes: updatedMinutes,
      secondsUsedRemainder: updatedRemainder,
      updatedAt: new Date(),
    });

    return {
      minutes: updatedMinutes,
      secondsUsedRemainder: updatedRemainder,
      availableSeconds: remainingSeconds,
    };
  });
}

// ============================================================
// UPDATE PAYMENT EMAIL
// ============================================================

export async function updateUserPaymentEmail(
  userId,
  email
) {
  const uid = requireUserId(userId);
  const normalizedEmail = normalizeGmail(email);

  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError(
        "User account not found.",
        404,
        "USER_NOT_FOUND"
      );
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
// ============================================================

export async function getUserPaymentEmail(userId) {
  const uid = requireUserId(userId);

  const snapshot = await usersCollection
    .doc(uid)
    .get();

  if (!snapshot.exists) {
    throw makeError(
      "User account not found.",
      404,
      "USER_NOT_FOUND"
    );
  }

  const user = snapshot.data();

  const email =
    user.paymentEmail ||
    user.email ||
    null;

  if (!email) {
    return null;
  }

  return normalizeGmail(email);
}

// ============================================================
// SET PENDING PAYMENT PACKAGE
// ============================================================

export async function setPendingPaymentPackage(
  userId,
  packageId
) {
  const uid = requireUserId(userId);
  const normalizedPackageId = normalizePackageId(packageId);

  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError(
        "User account not found.",
        404,
        "USER_NOT_FOUND"
      );
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
  const uid = requireUserId(userId);
  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError(
        "User account not found.",
        404,
        "USER_NOT_FOUND"
      );
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
