// ============================================================
// SA LIVE — AUTHENTICATION & AUTHORIZATION MIDDLEWARE
// ============================================================
// Firebase Admin SDK
// Express ES modules
//
// Exports:
//   verifyFirebaseToken
//   requireAdmin
//   requireHost
// ============================================================

import { getAuth } from "firebase-admin/auth";
import { db } from "../config/firebase.js";

// ============================================================
// STANDARD ERROR RESPONSE
// ============================================================

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

// ============================================================
// VERIFY FIREBASE ID TOKEN
// ============================================================

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorization = req.get("authorization");

    if (
      typeof authorization !== "string" ||
      authorization.length > 10000
    ) {
      return sendError(
        res,
        401,
        "Authentication required."
      );
    }

    const match = /^Bearer\s+(\S+)$/i.exec(
      authorization.trim()
    );

    if (!match) {
      return sendError(
        res,
        401,
        "Authentication required."
      );
    }

    const token = match[1];

    // Verify the token signature, issuer, audience and expiry.
    // Also check Firebase revocation status.
    const decodedToken = await getAuth().verifyIdToken(
      token,
      true
    );

    if (
      !decodedToken.uid ||
      typeof decodedToken.uid !== "string"
    ) {
      return sendError(
        res,
        401,
        "Invalid authentication token."
      );
    }

    req.user = Object.freeze({
      uid: decodedToken.uid,
      email:
        typeof decodedToken.email === "string"
          ? decodedToken.email
          : null,
      emailVerified:
        decodedToken.email_verified === true,
    });

    return next();
  } catch (error) {
    // Do not log the token or authorization header.
    // Invalid, expired and revoked tokens are unauthorized.
    if (
      error?.code === "auth/id-token-expired" ||
      error?.code === "auth/id-token-revoked" ||
      error?.code === "auth/invalid-id-token" ||
      error?.code === "auth/argument-error"
    ) {
      return sendError(
        res,
        401,
        "Invalid or expired authentication token."
      );
    }

    console.error(
      "Firebase authentication verification failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return sendError(
      res,
      503,
      "Authentication service is temporarily unavailable."
    );
  }
}

// ============================================================
// REQUIRE ACTIVE ADMINISTRATOR
// ============================================================

export async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (!uid) {
      return sendError(
        res,
        401,
        "Authentication required."
      );
    }

    const adminSnapshot = await db
      .collection("admins")
      .doc(uid)
      .get();

    if (
      !adminSnapshot.exists ||
      adminSnapshot.data()?.active !== true
    ) {
      return sendError(
        res,
        403,
        "Administrator access denied."
      );
    }

    req.admin = Object.freeze({
      uid,
    });

    return next();
  } catch (error) {
    console.error(
      "Administrator authorization failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return sendError(
      res,
      503,
      "Administrator authorization is temporarily unavailable."
    );
  }
}

// ============================================================
// REQUIRE ACTIVE HOST
// ============================================================

export async function requireHost(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (!uid) {
      return sendError(
        res,
        401,
        "Authentication required."
      );
    }

    const hostSnapshot = await db
      .collection("hosts")
      .where("firebaseUid", "==", uid)
      .limit(2)
      .get();

    if (hostSnapshot.empty) {
      return sendError(
        res,
        403,
        "No host account is linked to this user."
      );
    }

    // Multiple records for one Firebase UID indicate
    // inconsistent host-account data. Fail closed.
    if (hostSnapshot.size !== 1) {
      console.error(
        "Host authorization failed: duplicate host records."
      );

      return sendError(
        res,
        403,
        "Host account requires administrator review."
      );
    }

    const hostDoc = hostSnapshot.docs[0];
    const hostData = hostDoc.data();

    if (hostData.status !== "active") {
      return sendError(
        res,
        403,
        "Your host account is not active."
      );
    }

    // Return only server-loaded host data.
    req.host = Object.freeze({
      ...hostData,
      id: hostDoc.id,
    });

    return next();
   } catch (error) {
    console.error("Host authorization diagnostic:", {
      name: error?.name || "UnknownError",
      code: error?.code || "NO_ERROR_CODE",
      message:
        typeof error?.message === "string"
          ? error.message.slice(0, 500)
          : "No error message available",
    });

    return sendError(
      res,
      503,
      "Host authorization is temporarily unavailable."
    );
  }
}