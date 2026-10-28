
import { db } from "../config/firebase.js";
import {
  matchCustomerToGroupRoom,
} from "./groupRoomService.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessions = db.collection("callSessions");
const callRooms = db.collection("callRooms");

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

  // Legacy one-to-one reservations still block host availability.
  // Group-room reservations are handled by groupRoomService.
  if (host.activeCallId) {
    return false;
  }

  const lastSeenMs = timestampToMilliseconds(host.lastSeenAt);

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

/*
 * Verify the customer's current call pointer.
 *
 * Only clear activeCallId when the referenced call is demonstrably
 * ended, missing, or linked to a group room that is demonstrably ended
 * or missing. Do not clear a matched/active call just because it is old.
 */
async function validateUserForMatching(userId) {
  const userRef = usersCollection.doc(userId);

  const result = await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      return {
        error: {
          message: "User not found.",
          status: 404,
        },
      };
    }

    const user = userSnapshot.data();

    if (!hasPaidMinutes(user)) {
      return {
        error: {
          message:
            "You have no available minutes. Please buy minutes before starting a call.",
          status: 409,
        },
      };
    }

    const activeCallId = user.activeCallId;

    if (
      typeof activeCallId !== "string" ||
      !activeCallId.trim()
    ) {
      return { user };
    }

    const callRef = callSessions.doc(activeCallId);
    const callSnapshot = await transaction.get(callRef);

    // No call document exists for the stored pointer.
    if (!callSnapshot.exists) {
      transaction.update(userRef, {
        activeCallId: null,
        updatedAt: new Date(),
      });

      return {
        user: {
          ...user,
          activeCallId: null,
        },
        repaired: true,
      };
    }

    const call = callSnapshot.data();

    // Explicitly finished calls no longer reserve the customer.
    if (
      call.endedAt ||
      ["completed", "ended", "cancelled", "failed"].includes(
        String(call.status || "").toLowerCase()
      )
    ) {
      transaction.update(userRef, {
        activeCallId: null,
        updatedAt: new Date(),
      });

      return {
        user: {
          ...user,
          activeCallId: null,
        },
        repaired: true,
      };
    }

    // For group calls, inspect the shared room before deciding whether
    // a call pointer can safely be cleared.
    if (
      typeof call.groupRoomId === "string" &&
      call.groupRoomId.trim()
    ) {
      const roomRef = callRooms.doc(call.groupRoomId);
      const roomSnapshot = await transaction.get(roomRef);

      if (!roomSnapshot.exists) {
        transaction.update(userRef, {
          activeCallId: null,
          updatedAt: new Date(),
        });

        return {
          user: {
            ...user,
            activeCallId: null,
          },
          repaired: true,
        };
      }

      const room = roomSnapshot.data();

      if (
        room.endedAt ||
        ["ended", "completed", "cancelled"].includes(
          String(room.status || "").toLowerCase()
        )
      ) {
        transaction.update(userRef, {
          activeCallId: null,
          updatedAt: new Date(),
        });

        return {
          user: {
            ...user,
            activeCallId: null,
          },
          repaired: true,
        };
      }
    }

    // The call still looks live or its state is uncertain.
    // Preserve the pointer rather than risk overlapping calls.
    return {
      error: {
        message:
          "You already have a call in progress. If your previous call did not connect, please contact support so the call state can be checked.",
        status: 409,
      },
    };
  });

  if (result.error) {
    throw makeError(result.error.message, result.error.status);
  }

  return result.user;
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
 * MATCH CUSTOMER TO HOST GROUP ROOM
 *
 * groupRoomService remains responsible for the authoritative matching
 * transaction, host reservation, room capacity, and call creation.
 */
export async function matchUserToHost(userId) {
  const normalizedUserId = validateId(userId, "user ID");

  // Check and, where safe, repair the customer's existing call pointer.
  await validateUserForMatching(normalizedUserId);

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
    // This service must recheck eligibility and reservations atomically.
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
