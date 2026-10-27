
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

const VALID_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EMAIL_LENGTH = 254;

/*
|--------------------------------------------------------------------------
| VALIDATION HELPERS
|--------------------------------------------------------------------------
*/

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireUserId(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId.trim().length > 128 ||
    !VALID_UID_PATTERN.test(userId.trim())
  ) {
    throw makeError("A valid Firebase user ID is required.");
  }

  return userId.trim();
}

function normalizeMinutes(value) {
  const minutes = value ?? 0;

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw makeError("Invalid user minute balance.", 500);
  }

  return minutes;
}

function normalizeEmail(email) {
  if (typeof email !== "string") {
    throw makeError("A valid email address is required.");
  }

  const normalized = email.trim().toLowerCase();

  if (
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw makeError("A valid email address is required.");
  }

  return normalized;
}

function normalizeGmail(email) {
  const normalized = normalizeEmail(email);

  if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(normalized)) {
    throw makeError(
      "Please use a valid Gmail address ending in @gmail.com."
    );
  }

  return normalized;
}

function toUser(doc) {
  if (!doc?.exists) return null;

  return {
    id: doc.id,
    ...doc.data(),
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

function getTimestampMillis(value) {
  if (value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return 0;
}

/*
|--------------------------------------------------------------------------
| GET WEBSITE USER BY FIREBASE UID
|--------------------------------------------------------------------------
*/

export async function getUserById(userId) {
  const uid = requireUserId(userId);
  const snapshot = await usersCollection.doc(uid).get();

  return toUser(snapshot);
}

export async function getUserByUid(uid) {
  return getUserById(uid);
}

/*
|--------------------------------------------------------------------------
| GET OR CREATE WEBSITE USER
|--------------------------------------------------------------------------
| Call with an identity obtained from verified Firebase authentication.
| New accounts are NOT considered verification requests until submitted.
|--------------------------------------------------------------------------
*/

export async function getOrCreateUser(firebaseUser) {
  if (!firebaseUser || typeof firebaseUser !== "object") {
    throw makeError(
      "An authenticated Firebase user is required.",
      401
    );
  }

  const uid = requireUserId(firebaseUser.uid);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (snapshot.exists) {
      // Never overwrite balances, verification, role, or account state.
      return toUser(snapshot);
    }

    const email = getFirebaseEmail(firebaseUser);
    const now = new Date();

    const displayName =
      (typeof firebaseUser.displayName === "string"
        ? firebaseUser.displayName.trim().slice(0, 100)
        : "") || "SA LIVE User";

    const photoURL =
      typeof firebaseUser.photoURL === "string" &&
      firebaseUser.photoURL.trim()
        ? firebaseUser.photoURL.trim().slice(0, 2048)
        : null;

    const userData = {
      uid,
      email,
      paymentEmail: null,

      profile: {
        displayName,
        bio: "",
        photoURL,
      },

      verificationStatus: "not_submitted",

      verification: {
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },

      minutes: 0,
      activeCallId: null,
      role: "user",

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

/*
|--------------------------------------------------------------------------
| SUBMIT VERIFICATION REQUEST
|--------------------------------------------------------------------------
| The route must authenticate the user and pass their verified UID.
| The request is stored in users/{uid} for the admin panel to review.
|--------------------------------------------------------------------------
*/

export async function submitVerification(userId, email) {
  const uid = requireUserId(userId);
  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
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

    // A new submission or resubmission requires admin review.
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

/*
|--------------------------------------------------------------------------
| ADMIN: APPROVE VERIFICATION
|--------------------------------------------------------------------------
| The calling controller must enforce requireAdmin and pass the
| authenticated administrator's Firebase UID.
|--------------------------------------------------------------------------
*/

export async function approveVerification(userId, adminId) {
  const uid = requireUserId(userId);
  const reviewer = requireUserId(adminId);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
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

    if (user.verificationStatus !== "pending") {
      throw makeError(
        "This user has no pending verification request.",
        409
      );
    }

    if (!user.verification?.submittedAt) {
      throw makeError(
        "Cannot approve a verification request that was not submitted.",
        409
      );
    }

    if (!user.paymentEmail) {
      throw makeError(
        "Cannot approve verification without a saved payment email.",
        409
      );
    }

    normalizeGmail(user.paymentEmail);

    const now = new Date();

    transaction.update(userRef, {
      verificationStatus: "approved",
      "verification.reviewedAt": now,
      "verification.reviewedBy": reviewer,
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

/*
|--------------------------------------------------------------------------
| ADMIN: REJECT VERIFICATION
|--------------------------------------------------------------------------
*/

export async function rejectVerification(
  userId,
  adminId,
  reason = "Verification was not approved."
) {
  const uid = requireUserId(userId);
  const reviewer = requireUserId(adminId);

  if (typeof reason !== "string" || !reason.trim()) {
    throw makeError("A rejection reason is required.");
  }

  const normalizedReason = reason.trim().slice(0, 1000);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
    }

    const user = snapshot.data();

    if (user.verificationStatus === "approved") {
      throw makeError(
        "An approved user's verification cannot be rejected directly.",
        409
      );
    }

    if (
      user.verificationStatus !== "pending" ||
      !user.verification?.submittedAt
    ) {
      throw makeError(
        "This user has no pending verification request.",
        409
      );
    }

    const now = new Date();

    transaction.update(userRef, {
      verificationStatus: "rejected",
      "verification.reviewedAt": now,
      "verification.reviewedBy": reviewer,
      "verification.rejectionReason": normalizedReason,
      updatedAt: now,
    });

    return {
      success: true,
      verificationStatus: "rejected",
    };
  });
}

/*
|--------------------------------------------------------------------------
| ADMIN: GET PENDING VERIFICATION REQUESTS
|--------------------------------------------------------------------------
| Only submitted requests are returned.
| The calling controller must enforce requireAdmin.
|--------------------------------------------------------------------------
*/

export async function getPendingUsers() {
  const snapshot = await usersCollection
    .where("verificationStatus", "==", "pending")
    .get();

  return snapshot.docs
    .map(toUser)
    .filter((user) => Boolean(user?.verification?.submittedAt))
    .sort((a, b) => {
      const aTime = getTimestampMillis(
        a.verification?.submittedAt
      );

      const bTime = getTimestampMillis(
        b.verification?.submittedAt
      );

      return aTime - bTime;
    });
}

/*
|--------------------------------------------------------------------------
| GET USER MINUTES
|--------------------------------------------------------------------------
*/

export async function getUserMinutes(userId) {
  const uid = requireUserId(userId);
  const snapshot = await usersCollection.doc(uid).get();

  if (!snapshot.exists) {
    throw makeError("User account not found.", 404);
  }

  return normalizeMinutes(snapshot.data().minutes);
}

/*
|--------------------------------------------------------------------------
| ADD MINUTES
|--------------------------------------------------------------------------
| Only verified, deduplicated payment processing should call this.
| This function is not idempotent by itself.
|--------------------------------------------------------------------------
*/

export async function addMinutes(userId, minutes) {
  const uid = requireUserId(userId);

  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw makeError(
      "Minutes to add must be a positive whole number."
    );
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
    }

    const user = snapshot.data();

    if (user.verificationStatus !== "approved") {
      throw makeError(
        "User verification must be approved before minutes can be credited.",
        403
      );
    }

    const current = normalizeMinutes(user.minutes);
    const updated = current + minutes;

    if (!Number.isSafeInteger(updated)) {
      throw makeError(
        "The resulting minute balance is invalid.",
        500
      );
    }

    transaction.update(userRef, {
      minutes: updated,
      updatedAt: new Date(),
    });

    return updated;
  });
}

/*
|--------------------------------------------------------------------------
| DEDUCT MINUTES
|--------------------------------------------------------------------------
| Call billingService.js for call billing so balances and earnings are
| updated together in one Firestore transaction.
|--------------------------------------------------------------------------
*/

export async function deductMinutes(userId, minutes) {
  const uid = requireUserId(userId);

  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw makeError(
      "Minutes to deduct must be a positive whole number."
    );
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
    }

    const current = normalizeMinutes(snapshot.data().minutes);

    if (current < minutes) {
      throw makeError("Insufficient available minutes.", 409);
    }

    const updated = current - minutes;

    transaction.update(userRef, {
      minutes: updated,
      updatedAt: new Date(),
    });

    return updated;
  });
}

/*
|--------------------------------------------------------------------------
| UPDATE PAYMENT EMAIL
|--------------------------------------------------------------------------
*/

export async function updateUserPaymentEmail(userId, email) {
  const uid = requireUserId(userId);
  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
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

/*
|--------------------------------------------------------------------------
| GET PAYMENT EMAIL
|--------------------------------------------------------------------------
*/

export async function getUserPaymentEmail(userId) {
  const uid = requireUserId(userId);
  const snapshot = await usersCollection.doc(uid).get();

  if (!snapshot.exists) {
    throw makeError("User account not found.", 404);
  }

  const user = snapshot.data();
  const email = user.paymentEmail || user.email || null;

  if (!email) return null;

  return normalizeGmail(email);
}

/*
|--------------------------------------------------------------------------
| SET PENDING PAYMENT PACKAGE
|--------------------------------------------------------------------------
*/

export async function setPendingPaymentPackage(userId, packageId) {
  const uid = requireUserId(userId);

  if (
    typeof packageId !== "string" ||
    !packageId.trim() ||
    packageId.trim().length > 100
  ) {
    throw makeError("A valid package ID is required.");
  }

  const normalizedPackageId = packageId.trim();
  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
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

/*
|--------------------------------------------------------------------------
| CLEAR PENDING PAYMENT
|--------------------------------------------------------------------------
*/

export async function clearPendingPayment(userId) {
  const uid = requireUserId(userId);
  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw makeError("User account not found.", 404);
    }

    transaction.update(userRef, {
      pendingPaymentPackageId: null,
      updatedAt: new Date(),
    });
  });

  return { success: true };
}
