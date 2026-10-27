import { getAuth } from "firebase-admin/auth";
import { db, firebaseApp } from "../config/firebase.js";

const auth = getAuth(firebaseApp);

const users = db.collection("users");
const hosts = db.collection("hosts");
const admins = db.collection("admins");
const hostWithdrawals = db.collection("hostWithdrawals");
const payments = db.collection("payments");
const callSessions = db.collection("callSessions");

function fail(status, message) {
const error = new Error(message);
error.status = status;
throw error;
}

function normalizeDocumentId(value) {
if (
typeof value !== "string" ||
!value.trim() ||
value.trim().includes("/") ||
value.includes("\0") ||
value.trim().length > 256
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

// Also protect administrators identified by Firebase custom claims.
try {
const firebaseUser = await auth.getUser(firebaseUid);

if (firebaseUser.customClaims?.admin === true) {
  fail(
    409,
    "Administrator accounts cannot be removed or deactivated here."
  );
}

} catch (error) {
if (error?.status === 409) throw error;

if (error?.code === "auth/user-not-found") {
  return;
}

throw error;

}
}

async function revokeHostClaim(firebaseUid) {
let firebaseUser;

try {
firebaseUser = await auth.getUser(firebaseUid);
} catch (error) {
if (error?.code === "auth/user-not-found") {
return;
}

throw error;

}

const claims = { ...(firebaseUser.customClaims || {}) };

if (claims.host === true) {
delete claims.host;
await auth.setCustomUserClaims(firebaseUid, claims);
}

// Invalidate existing Firebase refresh tokens.
await auth.revokeRefreshTokens(firebaseUid);
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

async function ensureNoActiveCalls(field, documentId) {
const snapshot = await callSessions
.where(field, "==", documentId)
.where("status", "in", ["matching", "matched", "active"])
.limit(1)
.get();

if (!snapshot.empty) {
fail(
409,
"This account has an active or pending call. Resolve it before proceeding."
);
}
}

async function ensureNoUnresolvedPayments(userId) {
const snapshot = await payments
.where("userId", "==", userId)
.where("status", "in", ["pending", "processing"])
.limit(1)
.get();

if (!snapshot.empty) {
fail(
409,
"This user has an unresolved payment. Resolve it before removing the account."
);
}
}

/*

REMOVE USER PROFILE

--------------------------------------------------------------------------

Removes the website profile only.

Financial and call history remain preserved.

Firebase Authentication account deletion is deliberately not performed.

--------------------------------------------------------------------------

*/

export async function removeUserRecord(documentId) {
const id = normalizeDocumentId(documentId);
const userRef = users.doc(id);
const userSnapshot = await userRef.get();

if (!userSnapshot.exists) {
fail(404, "User record not found.");
}

const user = userSnapshot.data();
const firebaseUid = user.uid || user.firebaseUid || id;

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
await ensureNoActiveCalls("userId", id);
await ensureNoUnresolvedPayments(id);

// Do not delete payment records, call sessions, or financial history.
// Customer email verification is handled by Firebase Authentication.
await userRef.delete();

return {
removed: true,
documentId: id,
financialHistoryPreserved: true,
firebaseAuthAccountPreserved: true,
};
}

/*

DEACTIVATE HOST

--------------------------------------------------------------------------

Preserve the host record for earnings and audit history.

--------------------------------------------------------------------------

*/

export async function removeHostRecord(documentId) {
const id = normalizeDocumentId(documentId);
const hostRef = hosts.doc(id);
const hostSnapshot = await hostRef.get();

if (!hostSnapshot.exists) {
fail(404, "Host record not found.");
}

const host = hostSnapshot.data();
const firebaseUid = host.firebaseUid || host.uid;

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
await ensureNoActiveCalls("hostId", id);
await ensureNoPendingWithdrawals(id);

await revokeHostClaim(firebaseUid);

await hostRef.set(
{
active: false,
status: "inactive",
available: false,
acceptingCalls: false,
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