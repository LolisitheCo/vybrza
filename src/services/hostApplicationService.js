
import { db, firebaseApp } from "../config/firebase.js";
import { getAuth } from "firebase-admin/auth";

const auth = getAuth(firebaseApp);

const applications = db.collection("hostApplications");
const hosts = db.collection("hosts");
const users = db.collection("users");

export const HOST_CONTRACT_VERSION = "1.0";

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

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

  if (uid.includes("/")) {
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

  if (languages.length === 0) {
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
    if (error?.code === "auth/user-not-found") {
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
    fail(
      400,
      "The application email must match your verified account email."
    );
  }

  return user;
}

async function findUsernameConflict(username, uid) {
  const usernameLower = username.toLowerCase();

  const [
    applicationUsernameMatches,
    hostUsernameMatches,
    hostPublicUsernameMatches,
  ] = await Promise.all([
    applications
      .where("usernameLower", "==", usernameLower)
      .limit(20)
      .get(),

    hosts
      .where("usernameLower", "==", usernameLower)
      .limit(20)
      .get(),

    hosts
      .where("publicUsernameLower", "==", usernameLower)
      .limit(20)
      .get(),
  ]);

  const applicationConflict = applicationUsernameMatches.docs.some(
    (doc) => {
      const data = doc.data();

      return (
        doc.id !== uid &&
        !["rejected", "withdrawn"].includes(data.status)
      );
    }
  );

  const hostIds = new Set([
    ...hostUsernameMatches.docs.map((doc) => doc.id),
    ...hostPublicUsernameMatches.docs.map((doc) => doc.id),
  ]);

  const hostConflict = [...hostIds].some((hostId) => hostId !== uid);

  if (applicationConflict || hostConflict) {
    fail(409, "That username is already in use.");
  }
}

/*
|--------------------------------------------------------------------------
| SUBMIT WEBSITE HOST APPLICATION
|--------------------------------------------------------------------------
| The controller must pass the UID and email from verified Firebase auth.
| Application document ID is the Firebase UID.
|--------------------------------------------------------------------------
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
    const currentSnapshot = await transaction.get(applicationRef);

    if (currentSnapshot.exists) {
      const current = currentSnapshot.data();

      if (current.status === "pending") {
        fail(409, "Your host application is already being reviewed.");
      }

      if (
        ["approving", "approved"].includes(current.status)
      ) {
        fail(
          409,
          "Your host application has already been approved or is being processed."
        );
      }

      if (["suspended", "disabled"].includes(current.status)) {
        fail(
          403,
          "Your host account is restricted. Please contact support."
        );
      }

      if (current.status !== "rejected" && current.status !== "withdrawn") {
        fail(409, "An existing host application prevents resubmission.");
      }

      // Only a rejected or withdrawn application can be resubmitted.
      transaction.set(applicationRef, applicationData);
      return;
    }

    transaction.create(applicationRef, applicationData);
  });

  return {
    id: uid,
    ...applicationData,
    message: "Your host application has been submitted for review.",
  };
}

/*
|--------------------------------------------------------------------------
| ADMIN: GET PENDING HOST APPLICATIONS
|--------------------------------------------------------------------------
| The controller must enforce requireAdmin.
|--------------------------------------------------------------------------
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
|--------------------------------------------------------------------------
| ADMIN: APPROVE HOST APPLICATION
|--------------------------------------------------------------------------
| Firestore is the authoritative source of host access.
| The application and host status are changed in one transaction.
| The caller must enforce requireAdmin and pass the authenticated admin UID.
|--------------------------------------------------------------------------
*/


export async function approveHostApplication(applicationId, adminUid) {
  const uid = normalizeUid(applicationId);
  const reviewerUid = normalizeUid(adminUid);

  const applicationRef = applications.doc(uid);
  const hostRef = hosts.doc(uid);
  const userRef = users.doc(uid);

  const initialSnapshot = await applicationRef.get();

  if (!initialSnapshot.exists) {
    fail(404, "Host application not found.");
  }

  const initialApplication = initialSnapshot.data();

  if (!["pending", "approved"].includes(initialApplication.status)) {
    fail(409, "This application is not pending or approved.");
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
  const verifiedUser = await getVerifiedAccount(uid, email);

  // Check username conflicts before granting host access.
  await findUsernameConflict(initialApplication.username, uid);

  return db.runTransaction(async (transaction) => {
    // Read all documents before writing.
    const [applicationSnapshot, hostSnapshot, userSnapshot] =
      await Promise.all([
        transaction.get(applicationRef),
        transaction.get(hostRef),
        transaction.get(userRef),
      ]);

    if (!applicationSnapshot.exists) {
      fail(404, "Host application not found.");
    }

    const application = applicationSnapshot.data();

    if (!["pending", "approved"].includes(application.status)) {
      fail(409, "This application is no longer eligible for approval.");
    }

    if (
      application.firebaseUid !== uid ||
      application.contractAccepted !== true ||
      application.contractAcceptedBy !== uid ||
      application.contractVersion !== HOST_CONTRACT_VERSION
    ) {
      fail(409, "The application requires administrator review.");
    }

    const username = normalizeUsername(application.username);
    const usernameLower = username.toLowerCase();
    const now = new Date();

    // Create or activate the host profile.
    if (hostSnapshot.exists) {
      const existingHost = hostSnapshot.data();

      if (
        existingHost.firebaseUid !== uid ||
        !["pending", "active"].includes(existingHost.status)
      ) {
        fail(409, "The host record requires administrator review.");
      }

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

    // IMPORTANT: update the role used by customer/host login routing.
    if (userSnapshot.exists) {
      transaction.update(userRef, {
        role: "host",
        updatedAt: now,
      });
    } else {
      // Preserve the verified Firebase account details if its
      // Firestore profile hasn't been created yet.
      transaction.create(userRef, {
        uid,
        firebaseUid: uid,
        email,
        name:
          application.fullName ||
          verifiedUser.displayName ||
          "",
        displayName:
          application.fullName ||
          verifiedUser.displayName ||
          "",
        role: "host",
        minutes: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Repair an already-approved application as well as approving
    // a pending application for the first time.
    const wasAlreadyApproved = application.status === "approved";

    transaction.update(applicationRef, {
      status: "approved",
      reviewedAt: application.reviewedAt || now,
      reviewedBy: application.reviewedBy || reviewerUid,
      updatedAt: now,
      rejectionReason: null,
    });

    return {
      id: uid,
      firebaseUid: uid,
      email,
      alreadyApproved: wasAlreadyApproved,
      role: "host",
      message: wasAlreadyApproved
        ? "Host access synchronized successfully."
        : "Host application approved successfully.",
    };
  });
}


/*
|--------------------------------------------------------------------------
| ADMIN: REJECT HOST APPLICATION
|--------------------------------------------------------------------------
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
|--------------------------------------------------------------------------
| APPLICANT: GET OWN APPLICATION STATUS
|--------------------------------------------------------------------------
*/

export async function getHostApplicationStatus(firebaseUid) {
  const uid = normalizeUid(firebaseUid);
  const snapshot = await applications.doc(uid).get();

  if (!snapshot.exists) {
    return { status: "not_submitted" };
  }

  return serializeApplication(snapshot);
}
