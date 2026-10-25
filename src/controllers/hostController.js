
import {
  hostHeartbeat,
} from "../services/hostService.js";

import {
  getHostAvailabilityProfile,
  updateHostAvailabilityProfile,
  getPublicHostDirectory,
} from "../services/hostAvailabilityService.js";

import {
  startHostApplication,
  getHostApplicationStatus,
} from "../services/hostApplicationService.js";

const HOST_CONTRACT_VERSION = "1.0";

function getAuthenticatedUid(req) {
  return typeof req.user?.uid === "string" && req.user.uid.trim()
    ? req.user.uid.trim()
    : null;
}

function sendError(res, error, fallbackMessage, knownClientErrors = []) {
  const message = error?.message || "";

  if (knownClientErrors.includes(message)) {
    return res.status(400).json({
      success: false,
      message,
    });
  }

  if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
    return res.status(Number(error.status)).json({
      success: false,
      message: message || fallbackMessage,
    });
  }

  if (
    message === "Host not found." ||
    message === "Host account not found." ||
    message === "An active, linked host account is required." ||
    message === "Host account is not active."
  ) {
    return res.status(403).json({
      success: false,
      message,
    });
  }

  console.error(
    fallbackMessage,
    error?.code || message || "UNKNOWN_ERROR"
  );

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

/*
|--------------------------------------------------------------------------
| HOST HEARTBEAT
|--------------------------------------------------------------------------
*/

export async function heartbeat(req, res) {
  try {
    const hostId = req.hostAccount?.id;
    const firebaseUid = getAuthenticatedUid(req);

    if (!hostId || !firebaseUid) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const result = await hostHeartbeat(hostId, firebaseUid);

    return res.status(200).json({
      success: true,
      message: "Host heartbeat received.",
      host: result,
    });
  } catch (error) {
    return sendError(res, error, "Unable to update host presence.", [
      "Host not found.",
      "Host account does not match the authenticated user.",
      "Host account is not active.",
    ]);
  }
}

/*
|--------------------------------------------------------------------------
| GET MY HOST PROFILE
|--------------------------------------------------------------------------
*/

export async function getMyHostProfile(req, res) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const profile = await getHostAvailabilityProfile(hostId);

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Host profile not found.",
      });
    }

    return res.status(200).json({
      success: true,
      host: profile,
    });
  } catch (error) {
    return sendError(res, error, "Unable to load your host profile.");
  }
}

/*
|--------------------------------------------------------------------------
| UPDATE MY HOST PROFILE AND AVAILABILITY
|--------------------------------------------------------------------------
*/

export async function updateMyHostProfile(req, res) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const profile = await updateHostAvailabilityProfile(
      hostId,
      req.body || {}
    );

    return res.status(200).json({
      success: true,
      message: "Host availability saved.",
      host: profile,
    });
  } catch (error) {
    return sendError(res, error, "Unable to save your host availability.", [
      "Enter a public username.",
      "Username must be 3–32 characters and contain only letters, numbers, or underscores.",
      "Invalid availability schedule.",
      "Invalid availability entry.",
      "Choose a valid day.",
      "Each time slot must have a valid start and end time on the same day.",
      "Choose whether you want to accept calls.",
      "Invalid profile details.",
      "That host username is already in use.",
    ]);
  }
}

/*
|--------------------------------------------------------------------------
| PUBLIC HOST DIRECTORY
|--------------------------------------------------------------------------
*/

export async function publicHostDirectory(req, res) {
  try {
    const hosts = await getPublicHostDirectory();

    return res.status(200).json({
      success: true,
      hosts,
    });
  } catch (error) {
    return sendError(res, error, "Unable to load hosts right now.");
  }
}

/*
|--------------------------------------------------------------------------
| SUBMIT HOST APPLICATION
|--------------------------------------------------------------------------
| The authenticated Firebase account supplies the UID and email.
| Never accept these identity fields from the request body.
|--------------------------------------------------------------------------
*/

export async function applyToBecomeHost(req, res) {
  const firebaseUid = getAuthenticatedUid(req);

  if (!firebaseUid) {
    return res.status(401).json({
      success: false,
      message: "Please sign in to apply as a host.",
    });
  }

  if (req.user?.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: "Please verify your website account email before applying.",
    });
  }

  try {
    const body = req.body || {};

    const application = await startHostApplication({
      firebaseUid,
      email: req.user.email,
      fullName: body.fullName,
      username: body.username,
      phoneNumber: body.phoneNumber,
      country: body.country,
      dateOfBirth: body.dateOfBirth,
      bio: body.bio,
      languages: body.languages,
      applicationReason: body.applicationReason,
      contractAccepted: body.contractAccepted,
      contractVersion: HOST_CONTRACT_VERSION,
    });

    return res.status(201).json({
      success: true,
      message: "Host application submitted for review.",
      application,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to submit your host application.",
      [
        "Please use a valid email address.",
        "Your website account could not be verified.",
        "The application email must match your website account email.",
        "Please choose a host username.",
        "Username must contain 3–32 letters, numbers, or underscores.",
        "That host username is already in use.",
        "This Firebase account is already linked to a host.",
        "Multiple host records are linked to this website account.",
        "Your host account is suspended or disabled. Please contact support.",
        "Full legal name is required.",
        "Phone number is required.",
        "Country of residence is required.",
        "You must be at least 18 years old to apply.",
        "Enter a valid date of birth.",
        "Please provide a short biography.",
        "Please list at least one language you speak.",
        "Please explain why you want to become a host.",
        "You must accept the current host agreement to apply.",
        "Your host agreement acceptance is invalid.",
        "A host application is already being processed.",
        "A host application already exists for this account.",
      ]
    );
  }
}

/*
|--------------------------------------------------------------------------
| GET MY HOST APPLICATION STATUS
|--------------------------------------------------------------------------
*/

export async function getMyHostApplicationStatus(req, res) {
  const firebaseUid = getAuthenticatedUid(req);

  if (!firebaseUid) {
    return res.status(401).json({
      success: false,
      message: "Please sign in to view your application.",
    });
  }

  try {
    const application = await getHostApplicationStatus(firebaseUid);

    return res.status(200).json({
      success: true,
      application,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your host application status."
    );
  }
}
