
import { getAuth } from "firebase-admin/auth";
import { db } from "../config/firebase.js";

// ============================================================
// CONFIGURATION
// ============================================================

const HOSTS_COLLECTION = "hosts";
const ADMINS_COLLECTION = "admins";

const MAX_AUTHORIZATION_HEADER_LENGTH = 10_000;

// ============================================================
// STANDARD RESPONSE HELPERS
// ============================================================

function sendError(res, status, message, code = undefined) {
  const response = {
    success: false,
    message,
  };

  if (code) {
    response.code = code;
  }

  return res.status(status).json(response);
}

function logAuthorizationError(label, error) {
  // Never log authorization headers, ID tokens or private user data.
  console.error(label, {
    code: error?.code || "UNKNOWN_ERROR",
  });
}

// ============================================================
// VERIFY FIREBASE ID TOKEN
// ============================================================

/**
 * Website clients must send:
 *
 * Authorization: Bearer <Firebase ID token>
 *
 * Firebase Authentication is the source of identity.
 * The request body is never trusted for the user's UID.
 */

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorization = req.get("authorization");

    if (
      typeof authorization !== "string" ||
      authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
      return sendError(
        res,
        401,
        "Authentication required.",
        "AUTHENTICATION_REQUIRED"
      );
    }

    const match = /^Bearer\s+(\S+)$/i.exec(
      authorization.trim()
    );

    if (!match) {
      return sendError(
        res,
        401,
        "Authentication required.",
        "AUTHENTICATION_REQUIRED"
      );
    }

    // checkRevoked=true also checks whether the user's refresh
    // tokens have been revoked or their account disabled.
    const decodedToken = await getAuth().verifyIdToken(
      match[1],
      true
    );

    if (
      typeof decodedToken.uid !== "string" ||
      !decodedToken.uid.trim()
    ) {
      return sendError(
        res,
        401,
        "Invalid authentication token.",
        "INVALID_TOKEN"
      );
    }

    req.user = Object.freeze({
      uid: decodedToken.uid,
      email:
        typeof decodedToken.email === "string"
          ? decodedToken.email
          : null,
      emailVerified: decodedToken.email_verified === true,
    });

    return next();
  } catch (error) {
    const invalidTokenCodes = new Set([
      "auth/id-token-expired",
      "auth/id-token-revoked",
      "auth/invalid-id-token",
      "auth/argument-error",
      "auth/user-disabled",
      "auth/user-not-found",
    ]);

    if (invalidTokenCodes.has(error?.code)) {
      return sendError(
        res,
        401,
        "Invalid or expired authentication token.",
        "INVALID_OR_EXPIRED_TOKEN"
      );
    }

    logAuthorizationError(
      "Firebase authentication verification failed:",
      error
    );

    return sendError(
      res,
      503,
      "Authentication service is temporarily unavailable.",
      "AUTHENTICATION_SERVICE_UNAVAILABLE"
    );
  }
}

// ============================================================
// REQUIRE VERIFIED EMAIL
// ============================================================

/**
 * Apply only to endpoints requiring a verified email.
 *
 * Uses Firebase Authentication's email_verified claim.
 */

export async function requireVerifiedEmail(req, res, next) {
  if (!req.user?.uid) {
    return sendError(
      res,
      401,
      "Authentication required.",
      "AUTHENTICATION_REQUIRED"
    );
  }

  if (!req.user.email) {
    return sendError(
      res,
      403,
      "Add an email address to your Firebase account before continuing.",
      "EMAIL_REQUIRED"
    );
  }

  if (req.user.emailVerified !== true) {
    return sendError(
      res,
      403,
      "Please verify your email address before continuing.",
      "EMAIL_NOT_VERIFIED"
    );
  }

  return next();
}

// ============================================================
// REQUIRE ACTIVE ADMINISTRATOR
// ============================================================

/**
 * Firestore admins collection is authoritative.
 *
 * Document ID: Firebase UID
 * Required field: active === true
 */

export async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (typeof uid !== "string" || !uid.trim()) {
      return sendError(
        res,
        401,
        "Authentication required.",
        "AUTHENTICATION_REQUIRED"
      );
    }

    const adminSnapshot = await db
      .collection(ADMINS_COLLECTION)
      .doc(uid)
      .get();

    if (!adminSnapshot.exists) {
      return sendError(
        res,
        403,
        "Administrator access denied.",
        "ADMIN_ACCESS_DENIED"
      );
    }

    const adminData = adminSnapshot.data();

    if (adminData?.active !== true) {
      return sendError(
        res,
        403,
        "Administrator access denied.",
        "ADMIN_ACCESS_DENIED"
      );
    }

    req.admin = Object.freeze({
      uid,
    });

    return next();
  } catch (error) {
    logAuthorizationError(
      "Administrator authorization failed:",
      error
    );

    return sendError(
      res,
      503,
      "Administrator authorization is temporarily unavailable.",
      "ADMIN_AUTHORIZATION_UNAVAILABLE"
    );
  }
}

// ============================================================
// REQUIRE ACTIVE HOST
// ============================================================

/**
 * A Firebase account must be linked to exactly one active host.
 *
 * Expected Firestore structure:
 *
 * hosts/{hostDocumentId}
 * {
 *   firebaseUid: "Firebase Authentication UID",
 *   status: "active"
 * }
 *
 * Duplicate host records are denied.
 */

export async function requireHost(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (typeof uid !== "string" || !uid.trim()) {
      return sendError(
        res,
        401,
        "Authentication required.",
        "AUTHENTICATION_REQUIRED"
      );
    }

    const hostSnapshot = await db
      .collection(HOSTS_COLLECTION)
      .where("firebaseUid", "==", uid)
      .limit(2)
      .get();

    if (hostSnapshot.empty) {
      return sendError(
        res,
        403,
        "No host account is linked to this user.",
        "HOST_ACCOUNT_NOT_FOUND"
      );
    }

    if (hostSnapshot.size !== 1) {
      console.error(
        "Host authorization denied: duplicate host records."
      );

      return sendError(
        res,
        403,
        "Host account requires administrator review.",
        "DUPLICATE_HOST_RECORDS"
      );
    }

    const hostDoc = hostSnapshot.docs[0];
    const hostData = hostDoc.data();

    if (hostData.firebaseUid !== uid) {
      return sendError(
        res,
        403,
        "Host account does not match the authenticated user.",
        "HOST_UID_MISMATCH"
      );
    }

    if (hostData.status !== "active") {
      return sendError(
        res,
        403,
        "Your host account is not active.",
        "HOST_ACCOUNT_INACTIVE"
      );
    }

    // Expose only the host identity fields needed by controllers.
    req.hostAccount = Object.freeze({
      id: hostDoc.id,
      firebaseUid: uid,
      status: "active",
    });

    return next();
  } catch (error) {
    logAuthorizationError(
      "Host authorization failed:",
      error
    );

    return sendError(
      res,
      503,
      "Host authorization is temporarily unavailable.",
      "HOST_AUTHORIZATION_UNAVAILABLE"
    );
  }
}
