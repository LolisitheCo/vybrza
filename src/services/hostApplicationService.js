
import { db, firebaseApp } from "../config/firebase.js";
import { getAuth } from "firebase-admin/auth";

const auth = getAuth(firebaseApp);

const applications = db.collection("hostApplications");
const hosts = db.collection("hosts");
const users = db.collection("users");

export const HOST_CONTRACT_VERSION = "1.0";

const RESTRICTED_STATUSES = new Set(["suspended", "disabled"]);
const RESUBMITTABLE_STATUSES = new Set(["rejected", "withdrawn"]);

/* ============================================================
   HELPERS
============================================================ */

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normalizeString(value, field, maxLength, required = true) {
  if (typeof value !== "string") {
    if (!required) return "";
    fail(400, `${field} is required.`);
  }

  const result = value.trim();

  if (required && !result) {
    fail(400, `${field} is required.`);
  }

  if (result.length > maxLength) {
    fail(400, `${field} must be ${maxLength} characters or fewer.`);
  }

  return result;
}

function normalizeUid(value) {
  const uid = normalizeString(value, "Firebase UID", 128);

  if (uid.includes("/") || uid.includes("\0")) {
    fail(400, "Invalid Firebase UID.");
  }

  return uid;
}

function normalizeEmail(value) {
  const email = normalizeString(value, "Email", 254).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(400, "Please provide a valid email address.");
  }

  return email;
}

function normalizeUsername(value) {
  const username = normalizeString(value, "Username", 32);

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    fail(400, "Username must contain 3–32 letters, numbers, or underscores.");
  }

  return username;
}

function normalizeLanguages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    fail(400, "Please provide between 1 and 20 languages.");
  }

  const languages = [
    ...new Set(
      value.map((language) =>
        normalizeString(language, "Language", 40)
      )
    ),
  ];

  if (!languages.length) {
    fail(400, "Please provide at least one language.");
  }

  return languages;
}

function normalizeDateOfBirth(value) {
  const date = normalizeString(value, "Date of birth", 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(400, "Date of birth must use YYYY-MM-DD format.");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    fail(400, "Please provide a valid date of birth.");
  }

  const today = new Date();

  let age = today.getUTCFullYear() - parsed.getUTCFullYear();

  const birthdayNotReached =
    today.getUTCMonth() < parsed.getUTCMonth() ||
    (
      today.getUTCMonth() === parsed.getUTCMonth() &&
      today.getUTCDate() < parsed.getUTCDate()
    );

  if (birthdayNotReached) age--;

  if (age < 18) {
    fail(400, "You must be at least 18 years old to apply as a host.");
  }

  if (age > 120) {
    fail(400, "Please provide a valid date of birth.");
  }

  return date;
}

function serializeApplication(snapshot) {
  if (!snapshot?.exists) return null;

  const data = snapshot.data();

  return {
    id: snapshot.id,
    firebaseUid: data.firebaseUid,
    fullName: data.fullName,
    displayName: data.displayName,
    username: data.username,
    email: data.email,
    phoneNumber: data.phoneNumber,
    country: data.country,
    dateOfBirth: data.dateOfBirth,
    bio: data.bio,
    languages: data.languages,
    applicationReason: data.applicationReason,
    contractVersion: data.contractVersion,
    contractAcceptedAt: data.contractAcceptedAt,
    status: data.status,
    submittedAt: data.submittedAt,
    updatedAt: data.updatedAt,
    reviewedAt: data.reviewedAt || null,
    reviewedBy: data.reviewedBy || null,
    rejectionReason: data.rejectionReason || null,
  };
}

/* ============================================================
   ACCOUNT VERIFICATION
============================================================ */

async function getVerifiedAccount(uid, email) {
  let account;

  try {
    account = await auth.getUser(uid);
  } catch (error) {
    if (error?.code === "auth/user-not-found") {
      fail(401, "Your website account could not be verified.");
    }

    throw error;
  }

  if (account.disabled) {
    fail(403, "Your website account is disabled.");
  }

  if (!account.email || account.emailVerified !== true) {
    fail(403, "Verify your website email before applying.");
  }

  if (account.email.toLowerCase() !== email) {
    fail(400, "The application email must match your verified account email.");
  }

  return account;
}

/* ============================================================
   TRANSACTIONAL USERNAME UNIQUENESS
============================================================ */

async function assertUsernameAvailable(transaction, username, uid) {
  const usernameLower = username.toLowerCase();

  const applicationQuery = applications
    .where("usernameLower", "==", usernameLower);

  const hostUsernameQuery = hosts
    .where("usernameLower", "==", usernameLower);

  const publicUsernameQuery = hosts
    .where("publicUsernameLower", "==", usernameLower);

  const [
    applicationMatches,
    hostMatches,
    publicHostMatches,
  ] = await Promise.all([
    transaction.get(applicationQuery),
    transaction.get(hostUsernameQuery),
    transaction.get(publicUsernameQuery),
  ]);

  const applicationConflict = applicationMatches.docs.some((doc) => {
    const data = doc.data();

    return (
      doc.id !== uid &&
      !RESUBMITTABLE_STATUSES.has(data.status)
    );
  });

  const hostIds = new Set([
    ...hostMatches.docs.map((doc) => doc.id),
    ...publicHostMatches.docs.map((doc) => doc.id),
  ]);

  const hostConflict = [...hostIds].some((hostId) => hostId !== uid);

  if (applicationConflict || hostConflict) {
    fail(409, "That username is already in use.");
  }
}

/* ============================================================
   SUBMIT HOST APPLICATION
============================================================ */

export async function startHostApplication({
  firebaseUid,
  fullName,
  username,
  email,
  phoneNumber,
  country,
  dateOfBirth,
  bio,
  languages,
  applicationReason,
  contractAccepted,
  contractVersion,
}) {
  const uid = normalizeUid(firebaseUid);
  const normalizedEmail = normalizeEmail(email);

  const data = {
    firebaseUid: uid,
    fullName: normalizeString(fullName, "Full legal name", 120),
    username: normalizeUsername(username),
    email: normalizedEmail,
    phoneNumber: normalizeString(phoneNumber, "Phone number", 30),
    country: normalizeString(country, "Country", 80),
    dateOfBirth: normalizeDateOfBirth(dateOfBirth),
    bio: normalizeString(bio, "Biography", 1000),
    languages: normalizeLanguages(languages),
    applicationReason: normalizeString(
      applicationReason,
      "Reason for applying",
      1500
    ),
  };

  if (contractAccepted !== true) {
    fail(400, "You must accept the host agreement before applying.");
  }

  if (contractVersion !== HOST_CONTRACT_VERSION) {
    fail(
      400,
      "The host agreement has changed. Review and accept the current agreement."
    );
  }

  data.usernameLower = data.username.toLowerCase();

  await getVerifiedAccount(uid, normalizedEmail);

  const applicationRef = applications.doc(uid);
  const hostRef = hosts.doc(uid);

  const now = new Date();

  const applicationData = {
    ...data,
    status: "pending",
    contractVersion: HOST_CONTRACT_VERSION,
    contractAccepted: true,
    contractAcceptedAt: now,
    contractAcceptedBy: uid,
    submittedAt: now,
    updatedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
  };

  await db.runTransaction(async (transaction) => {
    const [
      currentSnapshot,
      hostSnapshot,
    ] = await Promise.all([
      transaction.get(applicationRef),
      transaction.get(hostRef),
    ]);

    if (hostSnapshot.exists) {
      const host = hostSnapshot.data();

      if (RESTRICTED_STATUSES.has(host.status)) {
        fail(403, "Your host account is restricted. Please contact support.");
      }

      if (host.status === "active") {
        fail(409, "You already have an active host account.");
      }
    }

    if (currentSnapshot.exists) {
      const current = currentSnapshot.data();

      if (current.status === "pending") {
        fail(409, "Your host application is already being reviewed.");
      }

      if (current.status === "approved") {
        fail(409, "Your host application has already been approved.");
      }

      if (RESTRICTED_STATUSES.has(current.status)) {
        fail(403, "Your host application is restricted. Please contact support.");
      }

      if (!RESUBMITTABLE_STATUSES.has(current.status)) {
        fail(409, "An existing application prevents resubmission.");
      }
    }

    // Username checks and application writes happen in the same transaction.
    await assertUsernameAvailable(
      transaction,
      data.username,
      uid
    );

    if (currentSnapshot.exists) {
      transaction.set(applicationRef, applicationData);
    } else {
      transaction.create(applicationRef, applicationData);
    }
  });

  return {
    id: uid,
    ...applicationData,
    message: "Your host application has been submitted for review.",
  };
}

/* ============================================================
   ADMIN: GET PENDING APPLICATIONS
============================================================ */

export async function getPendingHostApplications() {
  const snapshot = await applications
    .where("status", "==", "pending")
    .get();

  return snapshot.docs
    .map(serializeApplication)
    .sort((a, b) => {
      const first = a.submittedAt?.toMillis?.() ?? 0;
      const second = b.submittedAt?.toMillis?.() ?? 0;

      return first - second;
    });
}

/* ============================================================
   ADMIN: APPROVE APPLICATION
============================================================ */

export async function approveHostApplication(applicationId, adminUid) {
  const uid = normalizeUid(applicationId);
  const reviewerUid = normalizeUid(adminUid);

  const applicationRef = applications.doc(uid);
  const hostRef = hosts.doc(uid);
  const userRef = users.doc(uid);

  // Initial read is used to validate the external Firebase Auth account.
  const initialSnapshot = await applicationRef.get();

  if (!initialSnapshot.exists) {
    fail(404, "Host application not found.");
  }

  const initialApplication = initialSnapshot.data();

  if (initialApplication.status !== "pending") {
    fail(409, "Only pending applications can be approved.");
  }

  if (
    initialApplication.firebaseUid !== uid ||
    initialApplication.contractAccepted !== true ||
    !initialApplication.contractAcceptedAt ||
    initialApplication.contractAcceptedBy !== uid ||
    initialApplication.contractVersion !== HOST_CONTRACT_VERSION
  ) {
    fail(409, "The application requires administrator review.");
  }

  const email = normalizeEmail(initialApplication.email);

  // Check the date of birth again at approval time.
  normalizeDateOfBirth(initialApplication.dateOfBirth);

  // Firebase Auth cannot participate in a Firestore transaction.
  // Verify immediately before the Firestore approval transaction.
  await getVerifiedAccount(uid, email);

  return db.runTransaction(async (transaction) => {
    const [
      applicationSnapshot,
      hostSnapshot,
      userSnapshot,
    ] = await Promise.all([
      transaction.get(applicationRef),
      transaction.get(hostRef),
      transaction.get(userRef),
    ]);

    if (!applicationSnapshot.exists) {
      fail(404, "Host application not found.");
    }

    const application = applicationSnapshot.data();

    if (application.status !== "pending") {
      fail(409, "This application is no longer pending.");
    }

    if (
      application.firebaseUid !== uid ||
      application.contractAccepted !== true ||
      !application.contractAcceptedAt ||
      application.contractAcceptedBy !== uid ||
      application.contractVersion !== HOST_CONTRACT_VERSION
    ) {
      fail(409, "The application requires administrator review.");
    }

    if (normalizeEmail(application.email) !== email) {
      fail(409, "The application email changed during approval.");
    }

    normalizeDateOfBirth(application.dateOfBirth);

    const username = normalizeUsername(application.username);
    const usernameLower = username.toLowerCase();

    // Check username uniqueness inside the approval transaction.
    await assertUsernameAvailable(
      transaction,
      username,
      uid
    );

    const now = new Date();

    if (hostSnapshot.exists) {
      const existingHost = hostSnapshot.data();

      if (existingHost.firebaseUid !== uid) {
        fail(409, "The host record requires administrator review.");
      }

      if (RESTRICTED_STATUSES.has(existingHost.status)) {
        fail(403, "This host account is restricted and cannot be reactivated through approval.");
      }

      if (existingHost.status !== "pending") {
        fail(409, "An existing host account requires administrator review.");
      }

      // Preserve financial balances, active call state and other
      // operational fields. Only update application-owned profile fields.
      transaction.update(hostRef, {
        username,
        usernameLower,
        publicUsername: username,
        publicUsernameLower: usernameLower,
        displayName: application.fullName,
        bio: application.bio,
        languages: application.languages,
        role: "host",
        status: "active",
        acceptingCalls: existingHost.acceptingCalls === true,
        availability: Array.isArray(existingHost.availability)
          ? existingHost.availability
          : [],
        updatedAt: now,
      });
    } else {
      transaction.create(hostRef, {
        firebaseUid: uid,
        username,
        usernameLower,
        publicUsername: username,
        publicUsernameLower: usernameLower,
        displayName: application.fullName,
        bio: application.bio,
        languages: application.languages,
        role: "host",
        status: "active",
        acceptingCalls: false,
        availability: [],
        lastSeenAt: null,
        activeCallId: null,
        earningsCents: 0,
        availableBalanceCents: 0,
        totalEarningsCents: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (userSnapshot.exists) {
      const existingUser = userSnapshot.data();

      if (RESTRICTED_STATUSES.has(existingUser.status)) {
        fail(403, "This website account is restricted.");
      }

      if (
        existingUser.role &&
        !["customer", "host"].includes(existingUser.role)
      ) {
        fail(409, "The website account requires administrator review.");
      }

      transaction.update(userRef, {
        role: "host",
        updatedAt: now,
      });
    } else {
      transaction.create(userRef, {
        uid,
        firebaseUid: uid,
        email,
        name: application.fullName,
        displayName: application.fullName,
        role: "host",
        minutes: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    transaction.update(applicationRef, {
      status: "approved",
      reviewedAt: now,
      reviewedBy: reviewerUid,
      updatedAt: now,
      rejectionReason: null,
    });

    return {
      id: uid,
      firebaseUid: uid,
      email,
      alreadyApproved: false,
      role: "host",
      message: "Host application approved successfully.",
    };
  });
}

/* ============================================================
   ADMIN: REJECT APPLICATION
============================================================ */

export async function rejectHostApplication(
  applicationId,
  adminUid,
  reason = ""
) {
  const uid = normalizeUid(applicationId);
  const reviewerUid = normalizeUid(adminUid);

  const rejectionReason =
    typeof reason === "string"
      ? reason.trim().slice(0, 500)
      : "";

  const applicationRef = applications.doc(uid);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(applicationRef);

    if (!snapshot.exists) {
      fail(404, "Host application not found.");
    }

    if (snapshot.data().status !== "pending") {
      fail(409, "This application is no longer pending.");
    }

    const now = new Date();

    transaction.update(applicationRef, {
      status: "rejected",
      reviewedAt: now,
      reviewedBy: reviewerUid,
      rejectionReason: rejectionReason || null,
      updatedAt: now,
    });

    return {
      id: uid,
      status: "rejected",
      rejectionReason: rejectionReason || null,
    };
  });
}

/* ============================================================
   APPLICANT: GET OWN APPLICATION STATUS
============================================================ */

export async function getHostApplicationStatus(firebaseUid) {
  const uid = normalizeUid(firebaseUid);

  const snapshot = await applications.doc(uid).get();

  if (!snapshot.exists) {
    return { status: "not_submitted" };
  }

  return serializeApplication(snapshot);
}
