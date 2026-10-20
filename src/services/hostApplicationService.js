
import { db, firebaseApp } from "../config/firebase.js";
import { getAuth } from "firebase-admin/auth";

const applications = db.collection("hostApplications");
const drafts = db.collection("hostApplicationDrafts");

const auth = getAuth(firebaseApp);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

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

export async function submitHostApplicationEmail(
  telegramId,
  email
) {
  const id = String(telegramId);
  const normalizedEmail = normalizeEmail(email);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Please enter a valid email address.");
  }

  const draftRef = drafts.doc(id);
  const draftSnapshot = await draftRef.get();

  if (!draftSnapshot.exists ||
      draftSnapshot.data().awaitingEmail !== true) {
    throw new Error("Please start with /host application first.");
  }

  const existingAccount = await auth
    .getUserByEmail(normalizedEmail)
    .catch((error) => {
      if (error.code === "auth/user-not-found") return null;
      throw error;
    });

  if (existingAccount?.customClaims?.host === true) {
    await draftRef.delete();
    return { status: "already_host" };
  }

  const applicationRef = applications.doc(id);
  const previous = await applicationRef.get();

  if (previous.exists && previous.data().status === "approved") {
    await draftRef.delete();
    return { status: "approved" };
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

export async function getPendingHostApplications() {
  const snapshot = await applications
    .where("status", "==", "pending")
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
}

export async function approveHostApplication(
  applicationId,
  adminTelegramId
) {
  const ref = applications.doc(String(applicationId));
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new Error("Host application not found.");
  }

  const application = snapshot.data();

  if (application.status !== "pending") {
    throw new Error("This application is no longer pending.");
  }

  // The applicant must have created their Firebase account first.
  const firebaseUser = await auth.getUserByEmail(application.email);

  const existingClaims = firebaseUser.customClaims || {};

  await auth.setCustomUserClaims(firebaseUser.uid, {
    ...existingClaims,
    host: true,
  });

  await ref.update({
    status: "approved",
    firebaseUid: firebaseUser.uid,
    reviewedAt: new Date(),
    reviewedBy: String(adminTelegramId),
  });

  return {
    email: application.email,
    firebaseUid: firebaseUser.uid,
  };
}

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
