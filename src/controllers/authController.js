import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

const TERMS_VERSION = "2026-10-27-v1";
const USERS_COLLECTION = "users";

function responseError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function getTodayInSouthAfrica() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isAtLeast18(dateOfBirth) {
  if (typeof dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    return false;
  }

  const [year, month, day] = dateOfBirth.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }

  const today = getTodayInSouthAfrica();
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const latestEligible = new Date(Date.UTC(todayYear - 18, todayMonth - 1, todayDay));
  const latestEligibleString = [
    latestEligible.getUTCFullYear(),
    String(latestEligible.getUTCMonth() + 1).padStart(2, "0"),
    String(latestEligible.getUTCDate()).padStart(2, "0"),
  ].join("-");

  return dateOfBirth <= latestEligibleString;
}

export async function registerCustomer(req, res, next) {
  try {
    const uid = req.user?.uid;
    const email = typeof req.user?.email === "string"
      ? req.user.email.trim().toLowerCase()
      : "";
    const name = typeof req.body?.name === "string"
      ? req.body.name.trim()
      : "";
    const dateOfBirth = req.body?.dateOfBirth;

    if (!uid || !email) {
      throw responseError(400, "A valid email address is required to register.", "REGISTRATION_EMAIL_REQUIRED");
    }

    if (name.length < 2 || name.length > 100) {
      throw responseError(400, "Enter a name between 2 and 100 characters.", "INVALID_NAME");
    }

    if (req.body?.acceptedTerms !== true) {
      throw responseError(400, "You must accept the Terms & Conditions and policies.", "TERMS_REQUIRED");
    }

    if (!isAtLeast18(dateOfBirth)) {
      throw responseError(403, "You must be at least 18 years old to create a VYBRZA customer account.", "AGE_REQUIREMENT_NOT_MET");
    }

    const userRef = db.collection(USERS_COLLECTION).doc(uid);
    const existing = await userRef.get();

    if (existing.exists) {
      throw responseError(409, "A customer profile already exists for this account.", "PROFILE_ALREADY_EXISTS");
    }

    const now = FieldValue.serverTimestamp();
    await userRef.create({
      uid,
      name,
      email,
      role: "customer",
      accountType: "customer",
      minutes: 0,
      emailVerified: false,
      ageEligible: true,
      ageEligibilityCheckedAt: now,
      termsAccepted: true,
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(201).json({
      success: true,
      message: "Customer registration completed.",
      role: "customer",
    });
  } catch (error) {
    return next(error);
  }
}
