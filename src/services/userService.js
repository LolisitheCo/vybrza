import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

const VALID_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EMAIL_LENGTH = 254;

/*

VALIDATION HELPERS

--------------------------------------------------------------------------

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
if (!Number.isSafeInteger(value ?? 0) || (value ?? 0) < 0) {
throw makeError("Invalid user minute balance.", 500);
}

return value ?? 0;
}

function normalizeEmail(email) {
if (typeof email !== "string") {
throw makeError("A valid email address is required.");
}

const normalized = email.trim().toLowerCase();

if (
normalized.length > MAX_EMAIL_LENGTH ||
!/^[^\s@]+@[^\s@]+.[^\s@]+$/.test(normalized)
) {
throw makeError("A valid email address is required.");
}

return normalized;
}

function normalizeGmail(email) {
const normalized = normalizeEmail(email);

if (!/^[a-z0-9._%+-]+@gmail.com$/i.test(normalized)) {
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

/*

GET WEBSITE USER BY FIREBASE UID

--------------------------------------------------------------------------

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

GET OR CREATE WEBSITE USER

--------------------------------------------------------------------------

Call with an identity obtained from verified Firebase authentication.

Email verification is handled by Firebase Authentication, not an

administrator approval request.

--------------------------------------------------------------------------

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
  // Do not overwrite balances, account state, or assigned roles.
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

GET USER MINUTES

--------------------------------------------------------------------------

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

ADD MINUTES

--------------------------------------------------------------------------

Only verified, deduplicated payment processing should call this.

This function is not idempotent by itself.

--------------------------------------------------------------------------

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

DEDUCT MINUTES

--------------------------------------------------------------------------

Use billingService.js for call billing so balances and earnings

are updated together in one Firestore transaction.

--------------------------------------------------------------------------

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

UPDATE PAYMENT EMAIL

--------------------------------------------------------------------------

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

GET PAYMENT EMAIL

--------------------------------------------------------------------------

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

SET PENDING PAYMENT PACKAGE

--------------------------------------------------------------------------

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

CLEAR PENDING PAYMENT

--------------------------------------------------------------------------

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