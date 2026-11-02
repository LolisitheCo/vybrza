
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

// ============================================================
// SA LIVE — CUSTOMER MATCHING SERVICE
// ============================================================

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessionsCollection = db.collection("callSessions");
const callRoomsCollection = db.collection("callRooms");

// One host + a maximum of three customers.
export const MAX_GROUP_CUSTOMERS = 3;
export const MAX_GROUP_PARTICIPANTS = 4;

const HOST_TIMEOUT_MS = 45_000;
const GROUP_ROOM_PREFIX = "salive-group-";

const TERMINAL_CALL_STATUSES = new Set([
  "ended",
  "completed",
  "cancelled",
  "canceled",
  "failed",
  "expired",
]);

const ACTIVE_CALL_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

// ============================================================
// HELPERS
// ============================================================

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireDocumentId(value, fieldName = "ID") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    value.includes("/") ||
    value.includes("\0")
  ) {
    throw makeError(`${fieldName} is invalid.`);
  }

  return value.trim();
}

function timestampMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  const result = new Date(value).getTime();

  return Number.isFinite(result) ? result : 0;
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    return null;
  }

  return minutes;
}

function isTerminalCall(call) {
  if (!call) return true;

  if (call.endedAt) return true;

  return TERMINAL_CALL_STATUSES.has(
    String(call.status || "").toLowerCase()
  );
}

function isActiveCall(call) {
  return (
    Boolean(call) &&
    !isTerminalCall(call) &&
    ACTIVE_CALL_STATUSES.has(
      String(call.status || "").toLowerCase()
    )
  );
}

function hostHasRecentHeartbeat(host, now = Date.now()) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = now - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
}

function isHostBaseAvailable(host, now = new Date()) {
  if (!host || host.status !== "active") {
    return false;
  }

  if (
    typeof host.firebaseUid !== "string" ||
    !host.firebaseUid.trim()
  ) {
    return false;
  }

  if (host.acceptingCalls !== true) {
    return false;
  }

  if (!hostHasRecentHeartbeat(host, now.getTime())) {
    return false;
  }

  try {
    return isWithinHostSchedule(host, now) === true;
  } catch (error) {
    console.error(
      "[SA LIVE] Host schedule check failed:",
      error.message
    );

    return false;
  }
}

function getRoomCustomerIds(room) {
  if (!Array.isArray(room?.customerIds)) {
    return [];
  }

  return [
    ...new Set(
      room.customerIds.filter(
        (id) =>
          typeof id === "string" &&
          id.trim().length > 0
      ).map((id) => id.trim())
    ),
  ];
}

function roomHasCapacity(room, hostId) {
  if (!room || room.hostId !== hostId) {
    return false;
  }

  if (
    typeof room.roomName !== "string" ||
    !room.roomName.startsWith(GROUP_ROOM_PREFIX)
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) {
    return false;
  }

  const configuredMaximum = Number(
    room.maxCustomers ?? MAX_GROUP_CUSTOMERS
  );

  if (
    !Number.isSafeInteger(configuredMaximum) ||
    configuredMaximum < 1
  ) {
    return false;
  }

  const maximum = Math.min(
    configuredMaximum,
    MAX_GROUP_CUSTOMERS
  );

  return getRoomCustomerIds(room).length < maximum;
}

function getPublicHostProfile(hostId, host) {
  return {
    id: hostId,
    displayName:
      typeof host.displayName === "string" &&
      host.displayName.trim()
        ? host.displayName.trim().slice(0, 80)
        : typeof host.name === "string" && host.name.trim()
          ? host.name.trim().slice(0, 80)
          : "SA LIVE Host",

    username:
      typeof host.username === "string"
        ? host.username
        : null,

    photoURL:
      typeof host.photoURL === "string"
        ? host.photoURL
        : typeof host.profilePicture === "string"
          ? host.profilePicture
          : null,

    bio:
      typeof host.bio === "string"
        ? host.bio.slice(0, 500)
        : "",
  };
}

// ============================================================
// CHECK CUSTOMER RESERVATION
// ============================================================

async function checkCustomerReservation(
  transaction,
  user,
  userId
) {
  if (!user.activeCallId) {
    return {
      available: true,
      staleCallId: null,
    };
  }

  const oldCallId = requireDocumentId(
    user.activeCallId,
    "Active call ID"
  );

  const oldCallRef = callSessionsCollection.doc(oldCallId);
  const oldCallSnapshot = await transaction.get(oldCallRef);

  if (
    oldCallSnapshot.exists &&
    isActiveCall(oldCallSnapshot.data())
  ) {
    const oldCall = oldCallSnapshot.data();

    if (oldCall.userId !== userId) {
      throw makeError(
        "Your existing call reservation is inconsistent.",
        409
      );
    }

    return {
      available: false,
      staleCallId: null,
    };
  }

  return {
    available: true,
    staleCallId: oldCallId,
  };
}

// ============================================================
// CREATE ONE PENDING CUSTOMER REQUEST
// ============================================================

async function createCallRequestForHost(userId, hostId) {
  const userRef = usersCollection.doc(userId);
  const hostRef = hostsCollection.doc(hostId);
  const callRef = callSessionsCollection.doc();

  return db.runTransaction(async (transaction) => {
    // All reads must happen before writes.

    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    if (!userSnapshot.exists) {
      throw makeError("Customer account not found.", 404);
    }

    if (!hostSnapshot.exists) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    const user = userSnapshot.data();
    const host = {
      id: hostSnapshot.id,
      ...hostSnapshot.data(),
    };

    const now = new Date();

    if (
      user.accountStatus &&
      user.accountStatus !== "active"
    ) {
      throw makeError("Your account is not active.", 403);
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw makeError(
        "You need available minutes before starting a call.",
        403
      );
    }

    if (!isHostBaseAvailable(host, now)) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // Check the customer's existing reservation.
    const reservation = await checkCustomerReservation(
      transaction,
      user,
      userId
    );

    if (!reservation.available) {
      throw makeError(
        "You already have a call in progress. End it before starting another.",
        409
      );
    }

    // Read the host's existing group room, if any.
    let roomSnapshot = null;
    let roomRef = null;

    if (host.activeGroupRoomId) {
      const roomId = requireDocumentId(
        host.activeGroupRoomId,
        "Active group room ID"
      );

      roomRef = callRoomsCollection.doc(roomId);
      roomSnapshot = await transaction.get(roomRef);

      if (
        !roomSnapshot.exists ||
        !roomHasCapacity(roomSnapshot.data(), host.id)
      ) {
        return {
          matched: false,
          reason: "room_unavailable",
        };
      }
    }

    // Check any legacy one-to-one host reservation.
    let clearLegacyHostReservation = false;

    if (host.activeCallId) {
      const legacyCallId = requireDocumentId(
        host.activeCallId,
        "Host active call ID"
      );

      const legacyCallRef =
        callSessionsCollection.doc(legacyCallId);

      const legacyCallSnapshot = await transaction.get(
        legacyCallRef
      );

      if (
        legacyCallSnapshot.exists &&
        isActiveCall(legacyCallSnapshot.data())
      ) {
        // A host already using a legacy call cannot accept
        // a new group request.
        return {
          matched: false,
          reason: "host_unavailable",
        };
      }

      clearLegacyHostReservation = true;
    }

    // Create the waiting request. No room is created here.
    const callData = {
      userId,
      customerUid: userId,
      hostId,

      status: "matching",

      groupRoomId: null,
      roomId: null,
      roomUrl: null,

      createdAt: now,
      updatedAt: now,

      startedAt: null,
      endedAt: null,

      durationSeconds: 0,
      minutesUsed: 0,
      billableMinutes: 0,

      minutesAtStart: minutes,

      endReason: null,

      billingStatus: "pending",
      billedAt: null,
      billingError: null,

      customerCharge: 0,
      hostEarnings: 0,
      saLiveRevenue: 0,

      customerChargeCents: 0,
      hostEarningsCents: 0,
      saLiveRevenueCents: 0,

      hostPayoutStatus: "pending",
    };

    transaction.create(callRef, callData);

    const userUpdate = {
      activeCallId: callRef.id,
      updatedAt: now,
    };

    // The new request replaces only a stale reservation.
    transaction.update(userRef, userUpdate);

    if (clearLegacyHostReservation) {
      transaction.update(hostRef, {
        activeCallId: null,
        updatedAt: now,
      });
    }

    return {
      matched: true,

      call: {
        id: callRef.id,
        ...callData,
      },

      host: getPublicHostProfile(hostId, host),
    };
  });
}

// ============================================================
// MATCH CUSTOMER TO A HOST
// ============================================================

/**
 * Creates one pending request for an available host.
 *
 * This function deliberately does NOT:
 * - Create a LiveKit room.
 * - Attach the customer to a group room.
 * - Start the call timer.
 * - Deduct customer minutes.
 * - Pay host earnings.
 *
 * The host acceptance service is responsible for rechecking
 * capacity and attaching this existing request transactionally.
 */
export async function matchUserToHost(userId) {
  userId = requireDocumentId(userId, "Customer ID");

  // Verify the customer exists and has sufficient minutes.
  const userSnapshot = await usersCollection.doc(userId).get();

  if (!userSnapshot.exists) {
    throw makeError("Customer account not found.", 404);
  }

  const user = userSnapshot.data();

  if (
    user.accountStatus &&
    user.accountStatus !== "active"
  ) {
    throw makeError("Your account is not active.", 403);
  }

  const minutes = normalizeMinutes(user.minutes);

  if (minutes === null || minutes <= 0) {
    throw makeError(
      "You need available minutes before starting a call.",
      403
    );
  }

  // Candidate discovery only. The transaction below performs
  // the authoritative customer and host checks.
  const hostsSnapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const candidates = hostsSnapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((host) => isHostBaseAvailable(host))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const host of candidates) {
    try {
      const result = await createCallRequestForHost(
        userId,
        host.id
      );

      if (result.matched) {
        return result;
      }

      if (
        result.reason === "host_unavailable" ||
        result.reason === "room_unavailable"
      ) {
        continue;
      }
    } catch (error) {
      // A customer reservation conflict is not a reason to
      // silently try another host.
      if (
        error.message.includes("already have a call") ||
        error.message.includes("available minutes") ||
        error.message.includes("account") ||
        error.message.includes("not active")
      ) {
        throw error;
      }

      console.error(
        "[SA LIVE] Could not create host request:",
        host.id,
        error.message
      );
    }
  }

  return {
    matched: false,
    message:
      "No available host was found. Please try again shortly.",
    retry: true,
  };
}
