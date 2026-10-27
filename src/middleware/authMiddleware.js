
import { getAuth } from "firebase-admin/auth";
import { db } from "../config/firebase.js";

/*
|--------------------------------------------------------------------------
| STANDARD ERROR RESPONSE
|--------------------------------------------------------------------------
*/

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

/*
|--------------------------------------------------------------------------
| VERIFY FIREBASE ID TOKEN
|--------------------------------------------------------------------------
| Website clients must send:
| Authorization: Bearer <Firebase ID token>
|
| Never trust a UID, email, or role supplied in the request body.
|--------------------------------------------------------------------------
*/

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorization = req.get("authorization");

    if (
      typeof authorization !== "string" ||
      authorization.length > 10000
    ) {
      return sendError(res, 401, "Authentication required.");
    }

    const match = /^Bearer\s+(\S+)$/i.exec(
      authorization.trim()
    );

    if (!match) {
      return sendError(res, 401, "Authentication required.");
    }

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
        "Invalid authentication token."
      );
    }

    // Only use identity information verified by Firebase.
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

/*
|--------------------------------------------------------------------------
| REQUIRE ACTIVE ADMINISTRATOR
|--------------------------------------------------------------------------
| The Firestore admins collection is authoritative.
| Document ID: Firebase UID
| Required field: active === true
|--------------------------------------------------------------------------
*/

export async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (typeof uid !== "string" || !uid.trim()) {
      return sendError(res, 401, "Authentication required.");
    }

    const adminSnapshot = await db
      .collection("admins")
      .doc(uid)
      .get();

    if (!adminSnapshot.exists) {
      return sendError(
        res,
        403,
        "Administrator access denied."
      );
    }

    const adminData = adminSnapshot.data();

    if (adminData?.active !== true) {
      return sendError(
        res,
        403,
        "Administrator access denied."
      );
    }

    req.admin = Object.freeze({ uid });

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

/*
|--------------------------------------------------------------------------
| REQUIRE ACTIVE HOST
|--------------------------------------------------------------------------
| A Firebase account must be linked to exactly one active host record.
| Duplicate records are denied until an administrator resolves them.
|--------------------------------------------------------------------------
*/

export async function requireHost(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (typeof uid !== "string" || !uid.trim()) {
      return sendError(res, 401, "Authentication required.");
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

    if (hostSnapshot.size !== 1) {
      console.error(
        "Host authorization denied: duplicate host records."
      );

      return sendError(
        res,
        403,
        "Host account requires administrator review."
      );
    }

    const hostDoc = hostSnapshot.docs[0];
    const hostData = hostDoc.data();

    // Recheck the link and status before granting host access.
    if (hostData.firebaseUid !== uid) {
      return sendError(
        res,
        403,
        "Host account does not match the authenticated user."
      );
    }

    if (hostData.status !== "active") {
      return sendError(
        res,
        403,
        "Your host account is not active."
      );
    }

    // Keep the attached host object limited to authorization data.
    req.hostAccount = Object.freeze({
      id: hostDoc.id,
      firebaseUid: uid,
      status: "active",
    });

    return next();
  } catch (error) {
    console.error(
      "Host authorization failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return sendError(
      res,
      503,
      "Host authorization is temporarily unavailable."
    );
  }
}
