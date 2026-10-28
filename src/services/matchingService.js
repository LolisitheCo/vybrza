
import { db } from "../config/firebase.js";
import {
  matchCustomerToGroupRoom,
} from "./groupRoomService.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");

const HOST_TIMEOUT_MS = 45_000;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 150 ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw makeError(`A valid ${fieldName} is required.`, 400);
  }

  return value.trim();
}

function timestampToMilliseconds(value) {
  if (!value) return NaN;

  try {
    if (typeof value.toMillis === "function") {
      return value.toMillis();
    }

    if (typeof value.toDate === "function") {
      return value.toDate().getTime();
    }

    if (value instanceof Date) {
      return value.getTime();
    }

    if (
      typeof value === "string" ||
      typeof value === "number"
    ) {
      return new Date(value).getTime();
    }
  } catch {
    return NaN;
  }

  return NaN;
}

function isHostAvailable(host) {
  if (!host || host.status !== "active") {
    return false;
  }

  if (
    typeof host.firebaseUid !== "string" ||
    !host.firebaseUid.trim()
  ) {
    return false;
  }

  // Legacy one-to-one reservations still make a host unavailable.
  // Group reservations are handled by groupRoomService.js.
  if (host.activeCallId) {
    return false;
  }

  const lastSeenMs = timestampToMilliseconds(
    host.lastSeenAt
  );

  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  const ageMs = Date.now() - lastSeenMs;

  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
}

function hasPaidMinutes(user) {
  return (
    user &&
    Number.isSafeInteger(user.minutes) &&
    user.minutes > 0
  );
}

function validateUserForMatching(user) {
  if (!user) {
    throw makeError("User not found.", 404);
  }

  // Firebase email verification is enforced by requireVerifiedEmail
  // on the customer matching route.

  if (!hasPaidMinutes(user)) {
    throw makeError(
      "You have no available minutes. Please buy minutes before starting a call.",
      409
    );
  }

  if (user.activeCallId) {
    throw makeError(
      "You already have a call in progress.",
      409
    );
  }
}

function toSafeHost(hostId, host) {
  const safeHost = { id: hostId };

  const publicFields = [
    "displayName",
    "name",
    "bio",
    "photoURL",
    "profileImage",
    "profilePicture",
    "avatarUrl",
    "language",
    "languages",
  ];

  for (const field of publicFields) {
    const value = host[field];

    if (
      typeof value === "string" ||
      (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      )
    ) {
      safeHost[field] = value;
    }
  }

  return safeHost;
}

/*
|--------------------------------------------------------------------------
| MATCH CUSTOMER TO HOST GROUP ROOM
|--------------------------------------------------------------------------
|
| Each customer receives a separate callSessions document.
| Up to three customers can share a host's group room.
|
| groupRoomService.js is responsible for atomically checking:
| - customer eligibility and balance;
| - host availability and heartbeat;
| - existing group-room capacity;
| - user activeCallId;
| - host activeGroupRoomId;
| - creating the individual call session.
|
| This file does not deduct minutes or calculate earnings.
|--------------------------------------------------------------------------
*/

export async function matchUserToHost(userId) {
  const normalizedUserId = validateId(userId, "user ID");

  const userSnapshot = await usersCollection
    .doc(normalizedUserId)
    .get();

  if (!userSnapshot.exists) {
    throw makeError("User not found.", 404);
  }

  validateUserForMatching(userSnapshot.data());

  const hostSnapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  if (hostSnapshot.empty) {
    return {
      matched: false,
      host: null,
      call: null,
      retry: true,
      reason: "no_host_available",
      message:
        "No available host was found. Please try again shortly.",
    };
  }

  const candidates = hostSnapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter(isHostAvailable)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (candidates.length === 0) {
    return {
      matched: false,
      host: null,
      call: null,
      retry: true,
      reason: "no_host_available",
      message:
        "No available host was found. Please try again shortly.",
    };
  }

  for (const candidate of candidates) {
    // groupRoomService performs the authoritative transaction.
    // It rechecks the user and host instead of trusting this
    // preliminary candidate list.
    const result = await matchCustomerToGroupRoom({
      userId: normalizedUserId,
      hostId: candidate.id,
    });

    if (result?.matched) {
      return {
        ...result,
        host:
          result.host ||
          toSafeHost(candidate.id, candidate),
        retry: false,
      };
    }

    // Try another host if this candidate became unavailable or
    // their group room cannot accept another customer.
  }

  return {
    matched: false,
    host: null,
    call: null,
    retry: true,
    reason: "no_group_room_available",
    message:
      "No available host or group-room space was found. Please try again shortly.",
  };
}
