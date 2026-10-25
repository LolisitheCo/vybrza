
import { db, firebaseApp } from "../config/firebase.js";
import { getAuth } from "firebase-admin/auth";
import { createHost } from "./hostService.js";

const auth = getAuth(firebaseApp);
const applications = db.collection("hostApplications");
const hosts = db.collection("hosts");

export const HOST_CONTRACT_VERSION = "1.0";

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
  return normalizeString(value, "Firebase UID", 128);
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
    fail(
      400,
      "Username must contain 3–32 letters, numbers, or underscores."
    );
  }

  return username;
}

function normalizeLanguages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    fail(400, "Please provide between 1 and 20 languages.");
  }

  const languages = [
    ...new Set(
      value.map((language) =>
        normalizeString(language, "Language", 40)
      )
    ),
  ];

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

  const birthdayHasNotOccurred =
    today.getUTCMonth() < parsed.getUTCMonth() ||
    (today.getUTCMonth() === parsed.getUTCMonth() &&
      today.getUTCDate() < parsed.getUTCDate());

  if (birthdayHasNotOccurred) age -= 1;

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

async function getVerifiedAccount(uid, email) {
  let user;

  try {
    user = await auth.getUser(uid);
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      fail(401, "Your website account could not be verified.");
    }

    throw error;
  }

  if (user.disabled) {
    fail(403, "Your website account is disabled.");
  }

  if (!user.email || user.emailVerified !== true) {
    fail(403, "Verify your website email before applying.");
  }

  if (user.email.toLowerCase() !== email) {
    fail(400, "The application email must match your verified account email.");
  }

  return user;
}

async function findUsernameConflict(username, uid) {
  const snapshot = await applications
    .where("usernameLower", "==", username.toLowerCase())
    .limit(10)
    .get();

  const applicationConflict = snapshot.docs.some((doc) => {
    const data = doc.data();

    return (
      doc.id !== uid &&
      data.status !== "rejected" &&
      data.status !== "withdrawn"
    );
  });

  if (applicationConflict) {
    fail(409, "That username is already in use.");
  }

  const hostSnapshot = await hosts
    .where("usernameLower", "==", username.toLowerCase())
    .limit(10)
    .get();

  const hostConflict = hostSnapshot.docs.some(
    (doc) => doc.data().firebaseUid !== uid
  );

  if (hostConflict) {
    fail(409, "That username is already in use.");
  }
}

/*
 * Website host application.
 *
 * The controller MUST pass req.user.uid from verified Firebase
 * authentication. Never trust a UID supplied by the browser body.
 */
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
    usernameLower: "",
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
      "The host agreement has changed. Review the current agreement and accept it before applying."
    );
  }

  data.usernameLower = data.username.toLowerCase();

  await getVerifiedAccount(uid, normalizedEmail);
  await findUsernameConflict(data.username, uid);

  const applicationRef = applications.doc(uid);
  const existingSnapshot = await applicationRef.get();

  if (existingSnapshot.exists) {
    const existing = existingSnapshot.data();

    if (existing.status === "pending") {
      fail(409, "Your host application is already being reviewed.");
    }

    if (existing.status === "approved" || existing.status === "approving") {
      fail(409, "Your host application has already been approved or is being processed.");
    }

    if (existing.status === "suspended" || existing.status === "disabled") {
      fail(403, "Your host account is restricted. Please contact support.");
    }
  }

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

  // Recheck status within a transaction to avoid overwriting an
  // application that was reviewed between the earlier read and write.
  await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(applicationRef);

    if (currentSnapshot.exists) {
      const current = currentSnapshot.data();

      if (
        ["pending", "approving", "approved", "suspended", "disabled"].includes(
          current.status
        )
      ) {
        fail(409, "An existing host application prevents resubmission.");
      }
    }

    transaction.set(applicationRef, applicationData);
  });

  return {
    id: uid,
    ...applicationData,
    message: "Your host application has been submitted for review.",
  };
}

/*
 * Admin: list pending applications.
 * The calling controller must enforce requireAdmin.
 */
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

/*
 * Admin: approve an application.
 * The calling controller must enforce requireAdmin and pass the
 * authenticated administrator's UID.
 */

export async function approveHostApplication(applicationId, adminUid) {
  const uid = normalizeUid(applicationId);
  const reviewerUid = normalizeUid(adminUid);

  const applicationRef = applications.doc(uid);
  const hostRef = hosts.doc(uid);

  const applicationSnapshot = await applicationRef.get();

  if (!applicationSnapshot.exists) {
    fail(404, "Host application not found.");
  }

  const application = applicationSnapshot.data();

  if (application.status === "approved") {
    return { id: uid, alreadyApproved: true };
  }

  if (application.status !== "pending") {
    fail(409, "This application is no longer pending.");
  }

  if (
    application.contractAccepted !== true ||
    !application.contractAcceptedAt ||
    application.contractAcceptedBy !== uid ||
    application.contractVersion !== HOST_CONTRACT_VERSION
  ) {
    fail(409, "The application has no valid recorded contract acceptance.");
  }

  const email = normalizeEmail(application.email);
  const firebaseUser = await getVerifiedAccount(uid, email);

  // Reserve the application so two admins cannot approve it at once.
  await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(applicationRef);

    if (
      !currentSnapshot.exists ||
      currentSnapshot.data().status !== "pending"
    ) {
      fail(409, "This application is no longer pending.");
    }

    transaction.update(applicationRef, {
      status: "approving",
      updatedAt: new Date(),
    });
  });

  let hostClaimChanged = false;

  try {
    // Create a pending host record first.
    // This must never grant active host access by itself.
    await createHost({
      firebaseUid: uid,
      username: application.username,
      displayName: application.fullName,
      status: "pending",
    });

    // Preserve unrelated custom claims.
    const existingClaims = firebaseUser.customClaims || {};

    if (existingClaims.host !== true) {
      await auth.setCustomUserClaims(uid, {
        ...existingClaims,
        host: true,
      });
      hostClaimChanged = true;
    }

    // Activate the host and approve the application atomically.
    await db.runTransaction(async (transaction) => {
      const currentApplication = await transaction.get(applicationRef);
      const currentHost = await transaction.get(hostRef);

      if (
        !currentApplication.exists ||
        currentApplication.data().status !== "approving"
      ) {
        fail(409, "The application approval state changed unexpectedly.");
      }

      if (!currentHost.exists) {
        fail(409, "The host record could not be found.");
      }

      const host = currentHost.data();

      if (
        host.firebaseUid !== uid ||
        !["pending", "active"].includes(host.status)
      ) {
        fail(409, "The host record requires administrator review.");
      }

      const now = new Date();

      transaction.update(hostRef, {
        status: "active",
        updatedAt: now,
      });

      transaction.update(applicationRef, {
        status: "approved",
        reviewedAt: now,
        reviewedBy: reviewerUid,
        updatedAt: now,
        rejectionReason: null,
      });
    });
  } catch (error) {
    // Restore the application to pending only if this operation
    // still owns the "approving" state.
    try {
      await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(applicationRef);

        if (
          currentSnapshot.exists &&
          currentSnapshot.data().status === "approving"
        ) {
          transaction.update(applicationRef, {
            status: "pending",
            updatedAt: new Date(),
          });
        }
      });
    } catch (rollbackError) {
      console.error(
        "Could not restore pending host application:",
        rollbackError?.code || "UNKNOWN_ERROR"
      );
    }

    // If this attempt added the host claim, remove only that claim.
    // Keep all unrelated custom claims.
    if (hostClaimChanged) {
      try {
        const latestUser = await auth.getUser(uid);
        const latestClaims = { ...(latestUser.customClaims || {}) };
        delete latestClaims.host;

        await auth.setCustomUserClaims(uid, latestClaims);
      } catch (claimError) {
        console.error(
          "Could not roll back host custom claim:",
          claimError?.code || "UNKNOWN_ERROR"
        );
      }
    }

    throw error;
  }

  return {
    id: uid,
    firebaseUid: uid,
    email,
    alreadyApproved: false,
  };
}


/*
 * Admin: reject a pending application.
 */
export async function rejectHostApplication(
  applicationId,
  adminUid,
  reason = ""
) {
  const uid = normalizeUid(applicationId);
  const reviewerUid = normalizeUid(adminUid);

  const rejectionReason =
    typeof reason === "string" ? reason.trim().slice(0, 500) : "";

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

/*
 * Applicant: check their own application status.
 */
export async function getHostApplicationStatus(firebaseUid) {
  const uid = normalizeUid(firebaseUid);
  const snapshot = await applications.doc(uid).get();

  if (!snapshot.exists) {
    return { status: "not_submitted" };
  }

  return serializeApplication(snapshot);
}
