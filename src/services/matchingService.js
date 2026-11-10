
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

// ============================================================
// SA LIVE — CUSTOMER MATCHING SERVICE
// ============================================================

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessionsCollection = db.collection("callSessions");
const callRoomsCollection = db.collection("callRooms");

// One host + a maximum of five customers.
export const MAX_GROUP_CUSTOMERS = 5;
export const MAX_GROUP_PARTICIPANTS = 6;

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

const GROUP_MEMBER_STATUSES = new Set([
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

// ============================================================
// GROUP ROOM VALIDATION
// ============================================================

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

  if (
    !Array.isArray(room.customerIds) ||
    !Array.isArray(room.callIds)
  ) {
    return false;
  }

  const customerIds = room.customerIds;
  const callIds = room.callIds;

  if (
    customerIds.length !== callIds.length ||
    customerIds.length > MAX_GROUP_CUSTOMERS ||
    new Set(customerIds).size !== customerIds.length ||
    new Set(callIds).size !== callIds.length
  ) {
    return false;
  }

  if (
    customerIds.some(
      (id) =>
        typeof id !== "string" ||
        !id.trim() ||
        id !== id.trim()
    ) ||
    callIds.some(
      (id) =>
        typeof id !== "string" ||
        !id.trim() ||
        id !== id.trim()
    )
  ) {
    return false;
  }

  return customerIds.length < MAX_GROUP_CUSTOMERS;
}

/**
 * Confirms that the room's customerIds and callIds
 * actually refer to the corresponding call documents.
 *
 * All reads happen before any transaction writes.
 */
async function validateExistingRoomMembers(
  transaction,
  roomSnapshot,
  room
) {
  const customerIds = room.customerIds;
  const callIds = room.callIds;

  if (customerIds.length === 0) {
    return true;
  }

  const callRefs = callIds.map((callId) =>
    callSessionsCollection.doc(callId)
  );

  const callSnapshots = await Promise.all(
    callRefs.map((ref) => transaction.get(ref))
  );

  for (let index = 0; index < callSnapshots.length; index++) {
    const snapshot = callSnapshots[index];

    if (!snapshot.exists) {
      return false;
    }

    const call = snapshot.data();

    const callCustomerId =
      call.userId ?? call.customerUid;

    if (
      call.hostId !== room.hostId ||
      callCustomerId !== customerIds[index] ||
      call.groupRoomId !== roomSnapshot.id ||
      !GROUP_MEMBER_STATUSES.has(call.status) ||
      call.endedAt
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// PUBLIC HOST PROFILE
// ============================================================

function getPublicHostProfile(hostId, host) {
  return {
    id: hostId,

    displayName:
      typeof host.displayName === "string" &&
      host.displayName.trim()
        ? host.displayName.trim().slice(0, 80)
        : typeof host.name === "string" &&
            host.name.trim()
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

  const oldCallRef =
    callSessionsCollection.doc(oldCallId);

  const oldCallSnapshot = await transaction.get(
    oldCallRef
  );

  if (oldCallSnapshot.exists) {
    const oldCall = oldCallSnapshot.data();

    // Never overwrite a reservation pointing to another
    // customer's call, even if that call is terminal.
    if (
      oldCall.userId !== userId &&
      oldCall.customerUid !== userId
    ) {
      throw makeError(
        "Your existing call reservation is inconsistent. Please contact support.",
        409
      );
    }

    if (isActiveCall(oldCall)) {
      return {
        available: false,
        staleCallId: null,
      };
    }
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
    // --------------------------------------------------------
    // READ CUSTOMER AND HOST
    // --------------------------------------------------------

    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    if (!userSnapshot.exists) {
      throw makeError(
        "Customer account not found.",
        404
      );
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

    // --------------------------------------------------------
    // CUSTOMER ACCOUNT VALIDATION
    // --------------------------------------------------------

    if (
      user.accountStatus &&
      user.accountStatus !== "active"
    ) {
      throw makeError(
        "Your account is not active.",
        403
      );
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw makeError(
        "You need available minutes before starting a call.",
        403
      );
    }

    // --------------------------------------------------------
    // HOST AVAILABILITY
    // --------------------------------------------------------

    if (!isHostBaseAvailable(host, now)) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // --------------------------------------------------------
    // CUSTOMER RESERVATION
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // EXISTING GROUP ROOM
    // --------------------------------------------------------

    let roomSnapshot = null;
    let roomRef = null;
    let room = null;

    if (host.activeGroupRoomId) {
      const roomId = requireDocumentId(
        host.activeGroupRoomId,
        "Active group room ID"
      );

      roomRef = callRoomsCollection.doc(roomId);

      roomSnapshot = await transaction.get(roomRef);

      if (!roomSnapshot.exists) {
        // The host points to a room that no longer exists.
        // Clear only the stale pointer we just checked.
        transaction.update(hostRef, {
          activeGroupRoomId: null,
          updatedAt: now,
        });
      } else {
        room = roomSnapshot.data();

        if (room.status === "ended" || room.endedAt) {
          transaction.update(hostRef, {
            activeGroupRoomId: null,
            updatedAt: now,
          });

          roomSnapshot = null;
          roomRef = null;
          room = null;
        } else {
          if (!roomHasCapacity(room, host.id)) {
            return {
              matched: false,
              reason: "room_unavailable",
            };
          }

          const membersValid =
            await validateExistingRoomMembers(
              transaction,
              roomSnapshot,
              room
            );

          if (!membersValid) {
            console.error(
              "[SA LIVE] Existing group room membership is inconsistent:",
              roomSnapshot.id
            );

            return {
              matched: false,
              reason: "room_unavailable",
            };
          }
        }
      }
    }

    // --------------------------------------------------------
    // LEGACY ONE-TO-ONE HOST RESERVATION
    // --------------------------------------------------------

    let clearLegacyHostReservation = false;

    if (host.activeCallId) {
      const legacyCallId = requireDocumentId(
        host.activeCallId,
        "Host active call ID"
      );

      const legacyCallRef =
        callSessionsCollection.doc(legacyCallId);

      const legacyCallSnapshot =
        await transaction.get(legacyCallRef);

      if (legacyCallSnapshot.exists) {
        const legacyCall = legacyCallSnapshot.data();

        if (isActiveCall(legacyCall)) {
          return {
            matched: false,
            reason: "host_unavailable",
          };
        }
      }

      clearLegacyHostReservation = true;
    }

    // --------------------------------------------------------
    // CREATE WAITING REQUEST
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // WRITE CUSTOMER AND HOST RESERVATIONS
    // --------------------------------------------------------

    transaction.create(callRef, callData);

    transaction.update(userRef, {
      activeCallId: callRef.id,
      updatedAt: now,
    });

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
// MATCH CUSTOMER TO SELECTED HOST
// ============================================================

/**
 * Creates one pending request for the selected host.
 *
 * This function deliberately does NOT:
 *
 * - Create a LiveKit room.
 * - Attach the customer to a group room.
 * - Start the call timer.
 * - Deduct customer minutes.
 * - Pay host earnings.
 *
 * Host acceptance is responsible for rechecking capacity
 * and attaching the existing request transactionally.
 */
export async function matchUserToHost(
  userId,
  selectedHostId
) {
  userId = requireDocumentId(
    userId,
    "Customer ID"
  );

  selectedHostId = requireDocumentId(
    selectedHostId,
    "Host ID"
  );

  // Never fall back to a different host.
  const result = await createCallRequestForHost(
    userId,
    selectedHostId
  );

  if (!result.matched) {
    const unavailable = makeError(
      result.reason === "room_unavailable"
        ? "This host's call room is currently full or unavailable. Please choose another host."
        : "This host is currently unavailable. Please choose another host.",
      409
    );

    unavailable.retry = true;

    throw unavailable;
  }

  return result;
}
