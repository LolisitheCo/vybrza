import { db, firebaseApp } from "../config/firebase.js";
import { getAuth } from "firebase-admin/auth";

const applications = db.collection("hostApplications");
const drafts = db.collection("hostApplicationDrafts");
const hosts = db.collection("hosts");
const accountLinks = db.collection("hostAccountLinks");

const auth = getAuth(firebaseApp);

/*

HELPERS

--------------------------------------------------------------------------

*/

function normalizeEmail(email) {
return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
return /^[^\s@]+@[^\s@]+.[^\s@]+$/.test(email);
}

async function getFirebaseUserByEmail(email) {
try {
return await auth.getUserByEmail(email);
} catch (error) {
if (error.code === "auth/user-not-found") {
return null;
}

throw error;

}
}

/*

START HOST APPLICATION

--------------------------------------------------------------------------

*/

export async function startHostApplication(telegramUser) {
const telegramId = String(telegramUser.id);
const ref = applications.doc(telegramId);
const snapshot = await ref.get();

if (snapshot.exists) {
const existing = snapshot.data();

if (existing.status === "approved") {
  return { status: "approved" };
}

if (existing.status === "pending") {
  return { status: "pending" };
}

}

await drafts.doc(telegramId).set({
telegramId,
telegramUsername: telegramUser.username || null,
firstName: telegramUser.first_name || "",
lastName: telegramUser.last_name || "",
awaitingEmail: true,
updatedAt: new Date(),
});

return { status: "awaiting_email" };
}

/*

SUBMIT HOST APPLICATION EMAIL

--------------------------------------------------------------------------

*/

export async function submitHostApplicationEmail(telegramId, email) {
const id = String(telegramId);
const normalizedEmail = normalizeEmail(email);

if (!isValidEmail(normalizedEmail)) {
throw new Error("Please enter a valid email address.");
}

const draftRef = drafts.doc(id);
const draftSnapshot = await draftRef.get();

if (
!draftSnapshot.exists ||
draftSnapshot.data().awaitingEmail !== true
) {
throw new Error("Please start with /host application first.");
}

const applicationRef = applications.doc(id);
const previous = await applicationRef.get();

if (previous.exists && previous.data().status === "approved") {
await draftRef.delete();
return { status: "approved" };
}

if (previous.exists && previous.data().status === "pending") {
await draftRef.delete();

return {
  status: "pending",
  email: previous.data().email,
};

}

const existingAccount = await getFirebaseUserByEmail(normalizedEmail);

// Do not allow an account linked to another Telegram host
// to be reused for this application.
if (existingAccount) {
const existingLink = await accountLinks.doc(existingAccount.uid).get();

if (
  existingLink.exists &&
  String(existingLink.data().telegramId) !== id
) {
  throw new Error(
    "That website account is already linked to another host."
  );
}

}

await applicationRef.set({
telegramId: id,
telegramUsername: draftSnapshot.data().telegramUsername || null,
firstName: draftSnapshot.data().firstName || "",
lastName: draftSnapshot.data().lastName || "",
email: normalizedEmail,
firebaseUid: existingAccount?.uid || null,
status: "pending",
submittedAt: new Date(),
reviewedAt: null,
reviewedBy: null,
rejectionReason: null,
});

await draftRef.delete();

return {
status: "pending",
email: normalizedEmail,
firebaseAccountExists: Boolean(existingAccount),
};
}

/*

GET PENDING HOST APPLICATIONS

--------------------------------------------------------------------------

*/

export async function getPendingHostApplications() {
const snapshot = await applications
.where("status", "==", "pending")
.get();

return snapshot.docs.map((docSnapshot) => ({
id: docSnapshot.id,
...docSnapshot.data(),
}));
}

/*

APPROVE HOST APPLICATION

--------------------------------------------------------------------------

*/

export async function approveHostApplication(
applicationId,
adminTelegramId
) {
const id = String(applicationId);
const ref = applications.doc(id);
const snapshot = await ref.get();

if (!snapshot.exists) {
throw new Error("Host application not found.");
}

const application = snapshot.data();

if (application.status === "approved") {
return {
email: application.email,
firebaseUid: application.firebaseUid || null,
alreadyApproved: true,
};
}

if (application.status !== "pending") {
throw new Error("This application is no longer pending.");
}

const email = normalizeEmail(application.email);

if (!isValidEmail(email)) {
throw new Error("This application has an invalid email address.");
}

// Find an existing Firebase account or create one during approval.
// The host can then use Forgot password on the website.
let firebaseUser = await getFirebaseUserByEmail(email);

if (!firebaseUser) {
try {
firebaseUser = await auth.createUser({
email,
emailVerified: false,
displayName:
[
application.firstName,
application.lastName,
]
.filter(Boolean)
.join(" ")
.trim() || "SA LIVE Host",
disabled: false,
});
} catch (error) {
// Handle another process creating the same account at the
// same time.
if (error.code === "auth/email-already-exists") {
firebaseUser = await auth.getUserByEmail(email);
} else {
throw error;
}
}
}

const telegramId = String(application.telegramId || id);
const hostId = `tg_${telegramId}`;
const hostRef = hosts.doc(hostId);
const linkRef = accountLinks.doc(firebaseUser.uid);

// Link one Telegram host to one Firebase account.
// Retrying the same approval is allowed.
await db.runTransaction(async (transaction) => {
const [hostSnapshot, linkSnapshot] = await Promise.all([
transaction.get(hostRef),
transaction.get(linkRef),
]);

if (hostSnapshot.exists) {
  const host = hostSnapshot.data();

  if (
    host.firebaseUid &&
    host.firebaseUid !== firebaseUser.uid
  ) {
    throw new Error(
      "This Telegram host is already linked to another website account."
    );
  }

  if (
    host.status === "suspended" ||
    host.status === "disabled"
  ) {
    throw new Error(
      "This host account is suspended or disabled. Review it before approval."
    );
  }
}

if (linkSnapshot.exists) {
  const link = linkSnapshot.data();

  if (
    String(link.telegramId) !== telegramId ||
    link.hostId !== hostId
  ) {
    throw new Error(
      "This website account is already linked to another host."
    );
  }
}

const now = new Date();

transaction.set(
  hostRef,
  {
    telegramId,
    username: application.telegramUsername || null,
    displayName:
      [
        application.firstName,
        application.lastName,
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || "SA LIVE Host",
    email,
    firebaseUid: firebaseUser.uid,
    status: "active",
    linkedAt: now,
    updatedAt: now,
    ...(hostSnapshot.exists ? {} : { createdAt: now }),
  },
  { merge: true }
);

transaction.set(
  linkRef,
  {
    firebaseUid: firebaseUser.uid,
    telegramId,
    hostId,
    linkedAt: now,
  },
  { merge: true }
);

});

// Preserve existing custom claims, including admin claims.
const refreshedUser = await auth.getUser(firebaseUser.uid);

await auth.setCustomUserClaims(firebaseUser.uid, {
...(refreshedUser.customClaims || {}),
host: true,
});

await ref.update({
status: "approved",
firebaseUid: firebaseUser.uid,
reviewedAt: new Date(),
reviewedBy: String(adminTelegramId),
rejectionReason: null,
});

return {
email,
firebaseUid: firebaseUser.uid,
alreadyApproved: false,
};
}

/*

REJECT HOST APPLICATION

--------------------------------------------------------------------------

*/

export async function rejectHostApplication(
applicationId,
adminTelegramId
) {
const ref = applications.doc(String(applicationId));
const snapshot = await ref.get();

if (!snapshot.exists) {
throw new Error("Host application not found.");
}

if (snapshot.data().status !== "pending") {
throw new Error("This application is no longer pending.");
}

await ref.update({
status: "rejected",
reviewedAt: new Date(),
reviewedBy: String(adminTelegramId),
});
}

/*

GET HOST APPLICATION STATUS

--------------------------------------------------------------------------

*/

export async function getHostApplicationStatus(telegramId) {
const snapshot = await applications.doc(String(telegramId)).get();

if (!snapshot.exists) {
return { status: "not_submitted" };
}

const data = snapshot.data();

return {
status: data.status,
email: data.email,
};
}