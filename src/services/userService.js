
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

// ============================================================
// VALIDATION HELPERS
// ============================================================

function requireUserId(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId.includes("/") ||
    userId.includes("\0") ||
    userId.length > 128
  ) {
    throw new Error("A valid Firebase user ID is required.");
  }

  return userId.trim();
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error("Invalid user minute balance.");
  }

  return minutes;
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
      "Please use a valid Gmail address ending in @gmail.com."
    );
  }

  return normalized;
}

function toUser(doc) {
  return {
    id: doc.id,
    ...doc.data(),
  };
}

// ============================================================
// GET WEBSITE USER BY FIREBASE UID
// ============================================================

export async function getUserById(userId) {
  const uid = requireUserId(userId);
  const snapshot = await usersCollection.doc(uid).get();

  if (!snapshot.exists) {
    return null;
  }

  return toUser(snapshot);
}

// Alias for services that use this function name.
export async function getUserByUid(uid) {
  return getUserById(uid);
}

// ============================================================
// GET OR CREATE WEBSITE USER
// ============================================================
// Call only with a UID obtained from verified Firebase
// Authentication middleware. Never use a body-supplied UID.
// ============================================================

export async function getOrCreateUser(firebaseUser) {
  if (!firebaseUser || typeof firebaseUser !== "object") {
    throw new Error("An authenticated Firebase user is required.");
  }

  const uid = requireUserId(firebaseUser.uid);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (snapshot.exists) {
      return toUser(snapshot);
    }

    const email =
      typeof firebaseUser.email === "string"
        ? firebaseUser.email.trim().toLowerCase()
        : null;

    const now = new Date();

    const displayName =
      (typeof firebaseUser.displayName === "string"
        ? firebaseUser.displayName.trim()
        : "") || "SA LIVE User";

    const userData = {
      uid,
      email,
      paymentEmail: email,
      profile: {
        displayName,
        bio: "",
        photoURL:
          typeof firebaseUser.photoURL === "string"
            ? firebaseUser.photoURL
            : null,
      },
      verificationStatus: "pending",
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

// ============================================================
// SUBMIT VERIFICATION
// ============================================================

export async function submitVerification(userId, email) {
  const uid = requireUserId(userId);
  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
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
// ============================================================

export async function approveVerification(userId, adminId) {
  const uid = requireUserId(userId);
  const reviewer = requireUserId(adminId);
  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
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

    if (!user.paymentEmail) {
      throw new Error(
        "Cannot approve verification without a saved payment email."
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

// ============================================================
// REJECT VERIFICATION
// ============================================================

export async function rejectVerification(
  userId,
  adminId,
  reason = "Verification was not approved."
) {
  const uid = requireUserId(userId);
  const reviewer = requireUserId(adminId);

  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("A rejection reason is required.");
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
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
      "verification.reviewedBy": reviewer,
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

  function timestamp(value) {
    if (value?.toMillis) return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return 0;
  }

  users.sort(
    (a, b) =>
      timestamp(a.verification?.submittedAt || a.createdAt) -
      timestamp(b.verification?.submittedAt || b.createdAt)
  );

  return users;
}

// ============================================================
// GET USER MINUTES
// ============================================================

export async function getUserMinutes(userId) {
  const uid = requireUserId(userId);
  const snapshot = await usersCollection.doc(uid).get();

  if (!snapshot.exists) {
    throw new Error("User account not found.");
  }

  return normalizeMinutes(snapshot.data().minutes);
}

// ============================================================
// ADD MINUTES
// Only verified payment processing should call this function.
// ============================================================

export async function addMinutes(userId, minutes) {
  const uid = requireUserId(userId);
  const amount = Number(minutes);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Minutes to add must be a positive whole number.");
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
    }

    const current = normalizeMinutes(snapshot.data().minutes);
    const updated = current + amount;

    if (!Number.isSafeInteger(updated)) {
      throw new Error("The resulting minute balance is invalid.");
    }

    transaction.update(userRef, {
      minutes: updated,
      updatedAt: new Date(),
    });

    return updated;
  });
}

// ============================================================
// DEDUCT MINUTES
// ============================================================

export async function deductMinutes(userId, minutes) {
  const uid = requireUserId(userId);
  const amount = Number(minutes);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Minutes to deduct must be a positive whole number.");
  }

  const userRef = usersCollection.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
    }

    const current = normalizeMinutes(snapshot.data().minutes);

    if (current < amount) {
      throw new Error("Insufficient available minutes.");
    }

    const updated = current - amount;

    transaction.update(userRef, {
      minutes: updated,
      updatedAt: new Date(),
    });

    return updated;
  });
}

// ============================================================
// UPDATE PAYMENT EMAIL
// ============================================================

export async function updateUserPaymentEmail(userId, email) {
  const uid = requireUserId(userId);
  const normalizedEmail = normalizeGmail(email);
  const userRef = usersCollection.doc(uid);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
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
  const snapshot = await usersCollection.doc(uid).get();

  if (!snapshot.exists) {
    throw new Error("User account not found.");
  }

  const user = snapshot.data();
  const email = user.paymentEmail || user.email || null;

  if (!email) {
    return null;
  }

  return normalizeGmail(email);
}

// ============================================================
// SET PENDING PAYMENT PACKAGE
// ============================================================

export async function setPendingPaymentPackage(userId, packageId) {
  const uid = requireUserId(userId);

  if (typeof packageId !== "string" || !packageId.trim()) {
    throw new Error("A valid package ID is required.");
  }

  const userRef = usersCollection.doc(uid);
  const normalizedPackageId = packageId.trim();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);

    if (!snapshot.exists) {
      throw new Error("User account not found.");
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
      throw new Error("User account not found.");
    }

    transaction.update(userRef, {
      pendingPaymentPackageId: null,
      updatedAt: new Date(),
    });
  });

  return { success: true };
}
