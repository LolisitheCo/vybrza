
import { getAuth } from "firebase-admin/auth";
import { db, firebaseApp } from "../config/firebase.js";

const auth = getAuth(firebaseApp);

const users = db.collection("users");
const hosts = db.collection("hosts");
const admins = db.collection("admins");
const verifications = db.collection("verifications");
const hostWithdrawals = db.collection("hostWithdrawals");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeDocumentId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("/") ||
    value.includes("\0") ||
    value.length > 256
  ) {
    fail(400, "A valid document ID is required.");
  }

  return value.trim();
}

async function ensureNotAdmin(firebaseUid) {
  if (!firebaseUid) return;

  const adminSnapshot = await admins.doc(firebaseUid).get();

  if (adminSnapshot.exists) {
    fail(
      409,
      "Administrator accounts cannot be removed or deactivated here."
    );
  }
}

async function revokeHostClaim(firebaseUid) {
  if (!firebaseUid) return;

  let firebaseUser;

  try {
    firebaseUser = await auth.getUser(firebaseUid);
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      return;
    }

    throw error;
  }

  const claims = { ...(firebaseUser.customClaims || {}) };

  if (claims.host === true) {
    delete claims.host;
    await auth.setCustomUserClaims(firebaseUid, claims);
  }

  // Force refreshed authentication tokens after a role change.
  await auth.revokeRefreshTokens(firebaseUid);
}

async function deleteRelatedVerifications(userId) {
  const references = new Map();

  const directRef = verifications.doc(userId);
  const directSnapshot = await directRef.get();

  if (directSnapshot.exists) {
    references.set(directRef.path, directRef);
  }

  const snapshot = await verifications
    .where("userId", "==", userId)
    .get();

  for (const document of snapshot.docs) {
    references.set(document.ref.path, document.ref);
  }

  const refs = [...references.values()];

  for (let index = 0; index < refs.length; index += 400) {
    const batch = db.batch();

    for (const ref of refs.slice(index, index + 400)) {
      batch.delete(ref);
    }

    await batch.commit();
  }
}

async function ensureNoPendingWithdrawals(hostId) {
  const snapshot = await hostWithdrawals
    .where("hostId", "==", hostId)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!snapshot.empty) {
    fail(
      409,
      "This host has a pending withdrawal. Resolve it before deactivating the host."
    );
  }
}

export async function removeUserRecord(documentId) {
  const id = normalizeDocumentId(documentId);
  const userRef = users.doc(id);
  const userSnapshot = await userRef.get();

  if (!userSnapshot.exists) {
    fail(404, "User record not found.");
  }

  const user = userSnapshot.data();
  const firebaseUid = user.firebaseUid || id;

  if (user.role === "admin") {
    fail(409, "Administrator accounts cannot be removed here.");
  }

  if (user.activeCallId) {
    fail(
      409,
      "This user has an active call. End the call before removing the account."
    );
  }

  await ensureNotAdmin(firebaseUid);

  // Remove the user profile and verification state only.
  // Payment, call, and financial records are preserved.
  await deleteRelatedVerifications(id);
  await userRef.delete();

  return {
    removed: true,
    documentId: id,
    financialHistoryPreserved: true,
  };
}

export async function removeHostRecord(documentId) {
  const id = normalizeDocumentId(documentId);
  const hostRef = hosts.doc(id);
  const hostSnapshot = await hostRef.get();

  if (!hostSnapshot.exists) {
    fail(404, "Host record not found.");
  }

  const host = hostSnapshot.data();
  const firebaseUid = host.firebaseUid || host.firebaseUid;

  if (!firebaseUid) {
    fail(
      409,
      "This host has no linked Firebase account. Review the host record before proceeding."
    );
  }

  if (host.activeCallId) {
    fail(
      409,
      "This host has an active call. End the call before deactivating the host."
    );
  }

  await ensureNotAdmin(firebaseUid);
  await ensureNoPendingWithdrawals(id);

  // Revoke host privileges while preserving unrelated custom claims.
  await revokeHostClaim(firebaseUid);

  // Keep the host document, application, earnings, call history,
  // and withdrawal records for audit and financial reconciliation.
  await hostRef.set(
    {
      active: false,
      status: "inactive",
      available: false,
      deactivatedAt: new Date(),
      deactivationReason: "Deactivated by an administrator.",
      updatedAt: new Date(),
    },
    { merge: true }
  );

  return {
    removed: false,
    deactivated: true,
    documentId: id,
    financialHistoryPreserved: true,
    applicationHistoryPreserved: true,
  };
}
