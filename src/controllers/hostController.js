
import { hostHeartbeat } from "../services/hostService.js";

import {
  getHostAvailabilityProfile,
  updateHostAvailabilityProfile,
  getPublicHostDirectory,
} from "../services/hostAvailabilityService.js";

import {
  HOST_CONTRACT_VERSION,
  startHostApplication,
  getHostApplicationStatus,
} from "../services/hostApplicationService.js";

// ============================================================
// SA LIVE — HOST CONTROLLER
// Compatible with current host application and availability
// services.
// ============================================================

const APPLICATION_CLIENT_ERRORS = new Set([
  "A valid full name is required.",
  "A valid username is required.",
  "That username is already in use.",
  "A valid phone number is required.",
  "A country is required.",
  "A valid date of birth is required.",
  "You must be at least 18 years old to apply.",
  "You must be at least 18 years old to apply as a host.",
  "A valid bio is required.",
  "Please provide at least one language.",
  "A valid application reason is required.",
  "You must accept the host agreement before submitting.",
  "The host agreement has changed. Please review and accept it again.",
  "Your email address must be verified before applying.",
  "A host application is already pending.",
  "Your host application has already been approved.",
  "Your host account is currently restricted.",
  "You already have an active host account.",
]);

const PROFILE_CLIENT_ERRORS = new Set([
  "A valid host ID is required.",
  "Host account not found.",
  "Host authentication is required.",
  "Username must be between 3 and 30 characters.",
  "Username can only contain letters, numbers and underscores.",
  "Accepting calls must be true or false.",
  "Availability must be an array.",
  "Invalid availability slot.",
  "Each availability slot needs a valid weekday, start time and end time.",
  "Availability start and end times cannot be the same.",
  "Duplicate availability slots are not allowed.",
  "You can add a maximum of 21 availability slots.",
  "That username is already in use.",
  "You are not authorized to update this host profile.",
]);

// ============================================================
// ERROR HANDLING
// ============================================================

function sendError(res, error, knownMessages = new Set()) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : "An unexpected error occurred.";

  const status =
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : knownMessages.has(message)
        ? 400
        : 500;

  if (status >= 500) {
    console.error("[SA LIVE HOST CONTROLLER]", {
      message,
      code: error?.code || null,
    });

    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }

  return res.status(status).json({
    success: false,
    message,
  });
}

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

function getAuthenticatedUid(req) {
  const uid = req.user?.uid;

  if (typeof uid !== "string" || !uid.trim()) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }

  return uid;
}

function getAuthenticatedEmail(req) {
  const email = req.user?.email;

  if (typeof email !== "string" || !email.trim()) {
    const error = new Error("A verified email address is required.");
    error.status = 403;
    throw error;
  }

  return email.trim().toLowerCase();
}

function getAuthenticatedHostId(req) {
  const uid = getAuthenticatedUid(req);
  const hostId = req.hostAccount?.id;

  if (
    typeof hostId !== "string" ||
    !hostId.trim() ||
    req.hostAccount?.firebaseUid !== uid ||
    req.hostAccount?.status !== "active"
  ) {
    const error = new Error("Active host account required.");
    error.status = 403;
    throw error;
  }

  return hostId.trim();
}

// ============================================================
// HOST HEARTBEAT
//
// Route middleware must include:
// verifyFirebaseToken
// requireHost
//
// This keeps online status tied to an authenticated active host.
// ============================================================

export async function heartbeat(req, res) {
  try {
    const uid = getAuthenticatedUid(req);
    const hostId = getAuthenticatedHostId(req);

    const result = await hostHeartbeat(hostId, uid);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Heartbeat updated.",
      ...(result && typeof result === "object" ? result : {}),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// ============================================================
// GET MY HOST PROFILE
// ============================================================

export async function getMyHostProfile(req, res) {
  try {
    const hostId = getAuthenticatedHostId(req);

    const profile = await getHostAvailabilityProfile(hostId);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      profile,
    });
  } catch (error) {
    return sendError(res, error, PROFILE_CLIENT_ERRORS);
  }
}

// ============================================================
// UPDATE MY HOST PROFILE
//
// The current service supports:
// - username
// - availability
// - acceptingCalls
//
// We merge omitted fields with the current profile because the
// service requires all three values when saving.
// ============================================================

export async function updateMyHostProfile(req, res) {
  try {
    const uid = getAuthenticatedUid(req);
    const hostId = getAuthenticatedHostId(req);

    const body =
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body)
        ? req.body
        : {};

    const allowedFields = new Set([
      "username",
      "availability",
      "acceptingCalls",
    ]);

    const unexpectedFields = Object.keys(body).filter(
      (field) => !allowedFields.has(field)
    );

    if (unexpectedFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Unsupported host profile fields were supplied.",
      });
    }

    const currentProfile =
      await getHostAvailabilityProfile(hostId);

    const username =
      Object.prototype.hasOwnProperty.call(body, "username")
        ? body.username
        : currentProfile.username;

    const availability =
      Object.prototype.hasOwnProperty.call(body, "availability")
        ? body.availability
        : currentProfile.availability;

    const acceptingCalls =
      Object.prototype.hasOwnProperty.call(body, "acceptingCalls")
        ? body.acceptingCalls
        : currentProfile.acceptingCalls;

    const profile = await updateHostAvailabilityProfile({
      hostId,
      firebaseUid: uid,
      username,
      availability,
      acceptingCalls,
    });

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Your host profile has been updated.",
      profile,
    });
  } catch (error) {
    return sendError(res, error, PROFILE_CLIENT_ERRORS);
  }
}

// ============================================================
// PUBLIC HOST DIRECTORY
//
// The availability service already calculates:
// - online
// - available
// - schedule
// - active group-room capacity
//
// Do not recalculate those values differently here.
// ============================================================

export async function publicHostDirectory(req, res) {
  try {
    const hosts = await getPublicHostDirectory();

    res.set({
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    });

    return res.status(200).json({
      success: true,
      count: hosts.length,
      hosts,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// ============================================================
// APPLY TO BECOME A HOST
//
// Frontend application fields:
// fullName
// username
// phoneNumber
// country
// dateOfBirth
// bio
// languages
// applicationReason
// contractAccepted
//
// UID and email are taken from the authenticated Firebase token.
// ============================================================

export async function applyToBecomeHost(req, res) {
  try {
    const firebaseUid = getAuthenticatedUid(req);
    const email = getAuthenticatedEmail(req);

    if (req.user?.emailVerified !== true) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email address before applying.",
      });
    }

    const body =
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body)
        ? req.body
        : {};

    const application = await startHostApplication({
      firebaseUid,
      email,

      fullName: body.fullName,
      username: body.username,
      phoneNumber: body.phoneNumber,
      country: body.country,
      dateOfBirth: body.dateOfBirth,
      bio: body.bio,
      languages: body.languages,
      applicationReason: body.applicationReason,

      contractAccepted: body.contractAccepted === true,
      contractVersion: HOST_CONTRACT_VERSION,
    });

    res.set("Cache-Control", "no-store");

    return res.status(201).json({
      success: true,
      message: "Your host application has been submitted for review.",
      application,
    });
  } catch (error) {
    return sendError(res, error, APPLICATION_CLIENT_ERRORS);
  }
}

// ============================================================
// GET MY APPLICATION STATUS
// Authenticated customer or host can check their own application.
// ============================================================

export async function getMyHostApplicationStatus(req, res) {
  try {
    const uid = getAuthenticatedUid(req);

    const application = await getHostApplicationStatus(uid);

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      application: application || null,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
