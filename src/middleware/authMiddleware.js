
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
| All protected website routes must use this middleware.
| The UID and email must come from the verified Firebase token,
| never from the request body or query string.
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

    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());

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
    if (
      error?.code === "auth/id-token-expired" ||
      error?.code === "auth/id-token-revoked" ||
      error?.code === "auth/invalid-id-token" ||
      error?.code === "auth/argument-error" ||
      error?.code === "auth/user-disabled" ||
      error?.code === "auth/user-not-found"
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

/*
|--------------------------------------------------------------------------
| REQUIRE ACTIVE ADMINISTRATOR
|--------------------------------------------------------------------------
| Firestore remains the authoritative source of admin access.
| A client-side role or custom token claim alone is not sufficient.
|--------------------------------------------------------------------------
*/

export async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (!uid) {
      return sendError(res, 401, "Authentication required.");
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
| The host must have exactly one active host record associated
| with the authenticated Firebase UID.
|--------------------------------------------------------------------------
*/

export async function requireHost(req, res, next) {
  try {
    const uid = req.user?.uid;

    if (!uid) {
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

    if (hostData.firebaseUid !== uid) {
      return sendError(
        res,
        403,
        "Host account does not match the authenticated user."
      );
    }

    // Expose only the fields host controllers need for authorization.
req.hostAccount = Object.freeze({
  id: hostDoc.id,
  firebaseUid: uid,
  status: hostData.status,
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
