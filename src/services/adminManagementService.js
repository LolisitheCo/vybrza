
import { getAuth } from "firebase-admin/auth";
import { db, firebaseApp } from "../config/firebase.js";

const auth = getAuth(firebaseApp);
const users = db.collection("users");
const hosts = db.collection("hosts");
const applications = db.collection("hostApplications");
const drafts = db.collection("hostApplicationDrafts");
const accountLinks = db.collection("hostAccountLinks");
const admins = db.collection("admins");

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

  const snapshot = await admins.doc(firebaseUid).get();

  if (snapshot.exists) {
    fail(
      409,
      "This account has an administrator record and cannot be removed here."
    );
  }
}

async function removeHostClaim(firebaseUid) {
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

  if (claims.host !== true) return;

  delete claims.host;

  await auth.setCustomUserClaims(firebaseUid, claims);
  await auth.revokeRefreshTokens(firebaseUid);
}

async function deleteRelatedVerifications(userId, telegramId) {
  const verificationCollection = db.collection("verifications");
  const references = new Map();

  // Check common document IDs first.
  for (const id of [userId, telegramId]) {
    if (!id) continue;

    const ref = verificationCollection.doc(String(id));
    const snapshot = await ref.get();

    if (snapshot.exists) {
      references.set(ref.path, ref);
    }
  }

  // Also check common ownership fields.
  for (const [field, value] of [
    ["userId", userId],
    ["telegramId", telegramId],
  ]) {
    if (!value) continue;

    const snapshot = await verificationCollection
      .where(field, "==", String(value))
      .get();

    for (const document of snapshot.docs) {
      references.set(document.ref.path, document.ref);
    }
  }

  // Use batches to stay below Firestore's 500-write limit.
  const refs = [...references.values()];

  for (let index = 0; index < refs.length; index += 400) {
    const batch = db.batch();

    for (const ref of refs.slice(index, index + 400)) {
      batch.delete(ref);
    }

    await batch.commit();
  }
}

export async function removeUserRecord(documentId) {
  const id = normalizeDocumentId(documentId);
  const ref = users.doc(id);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    fail(404, "User record not found.");
  }

  const user = snapshot.data();

  if (user.role === "admin") {
    fail(409, "Administrator accounts cannot be removed here.");
  }

  if (user.activeCallId) {
    fail(
      409,
      "This user has an active call. End the call before removing the account."
    );
  }

  await ensureNotAdmin(user.firebaseUid);

  // Remove the profile and verification state, not financial history.
  await deleteRelatedVerifications(id, user.telegramId);
  await ref.delete();

  return {
    removed: true,
    documentId: id,
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
  const telegramId = host.telegramId
    ? String(host.telegramId)
    : null;
  const firebaseUid = host.firebaseUid || null;

  if (host.activeCallId) {
    fail(
      409,
      "This host has an active call. End the call before removing the host."
    );
  }

  await ensureNotAdmin(firebaseUid);

  // Revoke host privileges while preserving unrelated custom claims.
  await removeHostClaim(firebaseUid);

  const batch = db.batch();

  batch.delete(hostRef);

  // Application and draft documents use the Telegram ID as their ID.
  if (telegramId) {
    batch.delete(applications.doc(telegramId));
    batch.delete(drafts.doc(telegramId));
  }

  // Delete only the account link belonging to this host.
  if (firebaseUid) {
    const linkRef = accountLinks.doc(firebaseUid);
    const linkSnapshot = await linkRef.get();

    if (
      linkSnapshot.exists &&
      linkSnapshot.data().hostId === id
    ) {
      batch.delete(linkRef);
    }
  }

  await batch.commit();

  return {
    removed: true,
    documentId: id,
  };
}
