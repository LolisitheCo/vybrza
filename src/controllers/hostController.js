
import { hostHeartbeat } from "../services/hostService.js";

import {
  getHostAvailabilityProfile,
  updateHostAvailabilityProfile,
  getPublicHostDirectory,
} from "../services/hostAvailabilityService.js";

import {
  startHostApplication,
  getHostApplicationStatus,
} from "../services/hostApplicationService.js";

// ============================================================
// SA LIVE HOST CONTROLLER
// ============================================================

const HOST_CONTRACT_VERSION = "1.0";
const TIME_ZONE = "Africa/Johannesburg";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const APPLICATION_CLIENT_ERRORS = new Set([
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
]);

const PROFILE_CLIENT_ERRORS = new Set([
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

// ============================================================
// RESPONSE HELPERS
// ============================================================

function noStore(res) {
  res.set("Cache-Control", "no-store, private");
}

function sendSuccess(res, status, data) {
  return res.status(status).json({
    success: true,
    ...data,
  });
}

function sendClientError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function sendError(
  res,
  error,
  fallbackMessage,
  knownClientErrors = new Set()
) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : "";

  if (knownClientErrors.has(message)) {
    return sendClientError(res, 400, message);
  }

  const status = Number(error?.status);

  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  ) {
    return sendClientError(
      res,
      status,
      message || fallbackMessage
    );
  }

  if (
    message === "Host not found." ||
    message === "Host account not found." ||
    message === "An active, linked host account is required." ||
    message === "Host account is not active."
  ) {
    return sendClientError(res, 403, message);
  }

  console.error("[SA LIVE HOST CONTROLLER]", {
    message: fallbackMessage,
    code: error?.code || "UNKNOWN_ERROR",
    error: message || "No error message",
  });

  return sendClientError(res, 500, fallbackMessage);
}

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

function getAuthenticatedUid(req) {
  const uid = req.user?.uid;

  if (typeof uid !== "string" || !uid.trim()) {
    return null;
  }

  return uid.trim();
}

function getAuthenticatedHostId(req) {
  const hostId = req.hostAccount?.id;

  if (typeof hostId !== "string" || !hostId.trim()) {
    return null;
  }

  return hostId.trim();
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(
    object,
    property
  );
}

// ============================================================
// AVAILABILITY DISPLAY HELPERS
// ============================================================

function normalizeDay(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 6) {
    return {
      dayIndex: value,
      day: DAY_NAMES[value],
    };
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  const index = DAY_NAMES.findIndex(
    (day) => day.toLowerCase() === normalized
  );

  if (index !== -1) {
    return {
      dayIndex: index,
      day: DAY_NAMES[index],
    };
  }

  const shortIndex = DAY_NAMES.findIndex(
    (day) => day.slice(0, 3).toLowerCase() === normalized
  );

  if (shortIndex !== -1) {
    return {
      dayIndex: shortIndex,
      day: DAY_NAMES[shortIndex],
    };
  }

  return null;
}

function isValidTime(value) {
  if (typeof value !== "string") return false;

  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function getScheduleSource(host) {
  if (Array.isArray(host?.availability)) {
    return host.availability;
  }

  if (Array.isArray(host?.schedule)) {
    return host.schedule;
  }

  return [];
}

/**
 * Convert the saved weekly schedule into a predictable,
 * public-facing structure.
 *
 * The schedule is expressed in South African local time.
 * This does not claim that the host is online right now.
 */
function buildAvailableTimes(host) {
  const schedule = getScheduleSource(host);

  return schedule
    .filter((entry) => isPlainObject(entry))
    .map((entry) => {
      const dayInfo = normalizeDay(
        entry.day ?? entry.dayOfWeek
      );

      const startTime =
        entry.startTime ?? entry.start;

      const endTime =
        entry.endTime ?? entry.end;

      const enabled =
        entry.enabled !== false &&
        entry.available !== false;

      if (
        !dayInfo ||
        !isValidTime(startTime) ||
        !isValidTime(endTime) ||
        !enabled
      ) {
        return null;
      }

      return {
        day: dayInfo.day,
        dayIndex: dayInfo.dayIndex,
        startTime,
        endTime,
        label: `${dayInfo.day}, ${startTime}–${endTime}`,
        timeZone: TIME_ZONE,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.dayIndex !== b.dayIndex) {
        return a.dayIndex - b.dayIndex;
      }

      return a.startTime.localeCompare(b.startTime);
    });
}

/**
 * Only expose fields intended for the public host directory.
 * Never return Firebase identifiers, private account data,
 * payment details, bank details, or internal room reservations.
 */
function toPublicHost(host) {
  if (!isPlainObject(host)) return null;

  const availability = getScheduleSource(host);

  return {
    id:
      typeof host.id === "string"
        ? host.id
        : null,

    username:
      typeof host.username === "string"
        ? host.username
        : "",

    displayName:
      typeof host.displayName === "string"
        ? host.displayName
        : typeof host.name === "string"
          ? host.name
          : "SA LIVE Host",

    bio:
      typeof host.bio === "string"
        ? host.bio
        : "",

    photoURL:
      typeof host.photoURL === "string"
        ? host.photoURL
        : "",

    languages: Array.isArray(host.languages)
      ? host.languages.filter(
          (language) => typeof language === "string"
        )
      : typeof host.language === "string"
        ? [host.language]
        : [],

    // Account approval and live presence are different things.
    online: host.online === true,

    // This is the service's call-availability result.
    available: host.available === true,

    acceptingCalls: host.acceptingCalls === true,

    // Keep the saved schedule available to clients that need it.
    availability,

    // Use this field to display readable times on the website.
    availableTimes: buildAvailableTimes(host),

    timeZone: TIME_ZONE,
  };
}

// ============================================================
// HOST HEARTBEAT
// ============================================================

export async function heartbeat(req, res) {
  noStore(res);

  const hostId = getAuthenticatedHostId(req);
  const firebaseUid = getAuthenticatedUid(req);

  if (!hostId || !firebaseUid) {
    return sendClientError(
      res,
      401,
      "Authenticated host account required."
    );
  }

  try {
    const result = await hostHeartbeat(
      hostId,
      firebaseUid
    );

    return sendSuccess(res, 200, {
      message: "Host heartbeat received.",
      host: result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to update host presence."
    );
  }
}

// ============================================================
// GET MY HOST PROFILE
// ============================================================

export async function getMyHostProfile(req, res) {
  noStore(res);

  const hostId = getAuthenticatedHostId(req);

  if (!hostId) {
    return sendClientError(
      res,
      401,
      "Authenticated host account required."
    );
  }

  try {
    const profile = await getHostAvailabilityProfile(hostId);

    if (!profile) {
      return sendClientError(
        res,
        404,
        "Host profile not found."
      );
    }

    return sendSuccess(res, 200, {
      host: {
        ...profile,
        availableTimes: buildAvailableTimes(profile),
        timeZone: TIME_ZONE,
      },
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your host profile."
    );
  }
}

// ============================================================
// UPDATE MY HOST PROFILE AND AVAILABILITY
// ============================================================

export async function updateMyHostProfile(req, res) {
  noStore(res);

  const hostId = getAuthenticatedHostId(req);
  const firebaseUid = getAuthenticatedUid(req);

  if (!hostId || !firebaseUid) {
    return sendClientError(
      res,
      401,
      "Authenticated host account required."
    );
  }

  if (!isPlainObject(req.body)) {
    return sendClientError(
      res,
      400,
      "Invalid profile details."
    );
  }

  const body = req.body;

  if (
    !hasOwn(body, "publicUsername") &&
    !hasOwn(body, "username")
  ) {
    return sendClientError(
      res,
      400,
      "Enter a public username."
    );
  }

  if (
    !hasOwn(body, "availability") ||
    !hasOwn(body, "acceptingCalls")
  ) {
    return sendClientError(
      res,
      400,
      "Invalid profile details."
    );
  }

  if (typeof body.acceptingCalls !== "boolean") {
    return sendClientError(
      res,
      400,
      "Choose whether you want to accept calls."
    );
  }

  const username =
    body.publicUsername ?? body.username;

  try {
    const profile = await updateHostAvailabilityProfile({
      hostId,
      firebaseUid,
      username,
      availability: body.availability,
      acceptingCalls: body.acceptingCalls,
    });

    return sendSuccess(res, 200, {
      message: "Host availability saved.",
      host: {
        ...profile,
        availableTimes: buildAvailableTimes(profile),
        timeZone: TIME_ZONE,
      },
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to save your host availability.",
      PROFILE_CLIENT_ERRORS
    );
  }
}

// ============================================================
// PUBLIC HOST DIRECTORY
// ============================================================

export async function publicHostDirectory(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  try {
    const directory = await getPublicHostDirectory();

    const hosts = Array.isArray(directory)
      ? directory.map(toPublicHost).filter(Boolean)
      : [];

    return sendSuccess(res, 200, {
      hosts,
      timeZone: TIME_ZONE,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load hosts right now."
    );
  }
}

// ============================================================
// SUBMIT HOST APPLICATION
// ============================================================

export async function applyToBecomeHost(req, res) {
  noStore(res);

  const firebaseUid = getAuthenticatedUid(req);

  if (!firebaseUid) {
    return sendClientError(
      res,
      401,
      "Please sign in to apply as a host."
    );
  }

  if (req.user?.emailVerified !== true) {
    return sendClientError(
      res,
      403,
      "Please verify your website account email before applying."
    );
  }

  if (
    typeof req.user?.email !== "string" ||
    !req.user.email.trim()
  ) {
    return sendClientError(
      res,
      400,
      "A verified website account email is required."
    );
  }

  if (!isPlainObject(req.body)) {
    return sendClientError(
      res,
      400,
      "Invalid host application details."
    );
  }

  const body = req.body;

  try {
    const application = await startHostApplication({
      firebaseUid,
      email: req.user.email.trim(),

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

    return sendSuccess(res, 201, {
      message: "Host application submitted for review.",
      application,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to submit your host application.",
      APPLICATION_CLIENT_ERRORS
    );
  }
}

// ============================================================
// GET MY HOST APPLICATION STATUS
// ============================================================

export async function getMyHostApplicationStatus(req, res) {
  noStore(res);

  const firebaseUid = getAuthenticatedUid(req);

  if (!firebaseUid) {
    return sendClientError(
      res,
      401,
      "Please sign in to view your application."
    );
  }

  try {
    const application = await getHostApplicationStatus(
      firebaseUid
    );

    return sendSuccess(res, 200, {
      application: application ?? null,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your host application status."
    );
  }
}
