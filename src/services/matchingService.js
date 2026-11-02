
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

// ============================================================
// COLLECTIONS
// ============================================================

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessionsCollection = db.collection("callSessions");
const callRoomsCollection = db.collection("callRooms");

// ============================================================
// CONFIGURATION
// ============================================================

// One host + two customers = three participants total.
export const MAX_GROUP_CUSTOMERS = 3;

const HOST_TIMEOUT_MS = 45_000;
const GROUP_ROOM_PREFIX = "salive-group-";

const TERMINAL_CALL_STATUSES = new Set([
  "ended",
  "completed",
  "cancelled",
  "canceled",
  "failed",
]);

const ACTIVE_CALL_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

// ============================================================
// VALIDATION HELPERS
// ============================================================

function requireDocumentId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    value.includes("/") ||
    value.includes("\0")
  ) {
    throw new Error(`${fieldName} is invalid.`);
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

function hasRecentHeartbeat(host) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = Date.now() - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  return Number.isSafeInteger(minutes) && minutes >= 0
    ? minutes
    : null;
}

function isTerminalCall(call) {
  if (!call) return true;

  if (call.endedAt) return true;

  return TERMINAL_CALL_STATUSES.has(
    String(call.status ?? "").toLowerCase()
  );
}

function isActiveCall(call) {
  if (!call || isTerminalCall(call)) {
    return false;
  }

  return ACTIVE_CALL_STATUSES.has(
    String(call.status ?? "").toLowerCase()
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

  if (!hasRecentHeartbeat(host)) {
    return false;
  }

  try {
    return isWithinHostSchedule(host, now) === true;
  } catch {
    return false;
  }
}

// ============================================================
// GROUP ROOM CAPACITY
// ============================================================

function getRoomCustomerIds(room) {
  if (!Array.isArray(room?.customerIds)) {
    return [];
  }

  return [
    ...new Set(
      room.customerIds
        .filter(
          (id) =>
            typeof id === "string" &&
            id.trim().length > 0
        )
        .map((id) => id.trim())
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

  const customerIds = getRoomCustomerIds(room);

  const configuredMaximum = Number(
    room.maxCustomers ?? MAX_GROUP_CUSTOMERS
  );

  if (
    !Number.isInteger(configuredMaximum) ||
    configuredMaximum < 1
  ) {
    return false;
  }

  const effectiveMaximum = Math.min(
    configuredMaximum,
    MAX_GROUP_CUSTOMERS
  );

  return customerIds.length < effectiveMaximum;
}

// ============================================================
// PUBLIC HOST PROFILE
// ============================================================

function getPublicHostProfile(host) {
  return {
    id: host.id,
    displayName:
      host.displayName ||
      host.name ||
      host.username ||
      "SA LIVE Host",
    username: host.username || null,
    photoURL:
      host.photoURL ||
      host.profilePicture ||
      null,
    bio: host.bio || "",
  };
}

// ============================================================
// CUSTOMER VALIDATION
// ============================================================

/**
 * Ensures the customer has minutes and no existing active call.
 *
 * A dangling activeCallId is cleared only if the referenced
 * call is missing or terminal.
 */
export async function validateUserForMatching(userId) {
  userId = requireDocumentId(userId, "Customer ID");

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("Customer account not found.");
    }

    const user = userSnapshot.data();

    if (user.accountStatus && user.accountStatus !== "active") {
      throw new Error("Your account is not active.");
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw new Error(
        "You need available minutes before starting a call."
      );
    }

    if (!user.activeCallId) {
      return {
        ...user,
        id: userSnapshot.id,
        minutes,
      };
    }

    const activeCallId = requireDocumentId(
      user.activeCallId,
      "Active call ID"
    );

    const activeCallRef =
      callSessionsCollection.doc(activeCallId);

    const activeCallSnapshot = await transaction.get(
      activeCallRef
    );

    if (
      activeCallSnapshot.exists &&
      isActiveCall(activeCallSnapshot.data())
    ) {
      throw new Error(
        "You already have a call in progress. End it before starting another."
      );
    }

    transaction.update(userRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });

    return {
      ...user,
      id: userSnapshot.id,
      activeCallId: null,
      minutes,
    };
  });
}

// ============================================================
// HOST AVAILABILITY
// ============================================================

/**
 * Preliminary check only.
 *
 * Final availability is checked again inside the transaction
 * that creates the customer request.
 */
async function isHostAvailable(host, now = new Date()) {
  if (!isHostBaseAvailable(host, now)) {
    return false;
  }

  if (!host.activeGroupRoomId) {
    return !host.activeCallId;
  }

  let roomId;

  try {
    roomId = requireDocumentId(
      host.activeGroupRoomId,
      "Active group room ID"
    );
  } catch {
    return false;
  }

  const roomSnapshot = await callRoomsCollection
    .doc(roomId)
    .get();

  if (!roomSnapshot.exists) {
    return false;
  }

  return roomHasCapacity(
    roomSnapshot.data(),
    host.id
  );
}

// ============================================================
// CREATE CUSTOMER CALL REQUEST
// ============================================================

/**
 * Creates a pending call request.
 *
 * Does NOT:
 * - Create a LiveKit room.
 * - Start the call timer.
 * - Deduct customer minutes.
 * - Pay host earnings.
 *
 * IMPORTANT:
 * This does not reserve a group-room participant slot.
 * The host acceptance transaction MUST atomically recheck
 * room capacity and attach the customer.
 */
async function createCallRequestForHost(userId, hostId) {
  const userRef = usersCollection.doc(userId);
  const hostRef = hostsCollection.doc(hostId);
  const callRef = callSessionsCollection.doc();

  return db.runTransaction(async (transaction) => {
    // --------------------------------------------------------
    // READ CUSTOMER
    // --------------------------------------------------------

    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("Customer account not found.");
    }

    const user = userSnapshot.data();

    if (user.accountStatus && user.accountStatus !== "active") {
      throw new Error("Your account is not active.");
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw new Error(
        "You need available minutes before starting a call."
      );
    }

    // --------------------------------------------------------
    // READ HOST
    // --------------------------------------------------------

    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    const currentHost = {
      id: hostSnapshot.id,
      ...hostSnapshot.data(),
    };

    const now = new Date();

    if (!isHostBaseAvailable(currentHost, now)) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // --------------------------------------------------------
    // READ CUSTOMER'S EXISTING CALL
    // --------------------------------------------------------

    if (user.activeCallId) {
      const oldCallId = requireDocumentId(
        user.activeCallId,
        "Active call ID"
      );

      const oldCallRef =
        callSessionsCollection.doc(oldCallId);

      const oldCallSnapshot = await transaction.get(oldCallRef);

      if (
        oldCallSnapshot.exists &&
        isActiveCall(oldCallSnapshot.data())
      ) {
        throw new Error(
          "You already have a call in progress. End it before starting another."
        );
      }
    }

    // --------------------------------------------------------
    // READ GROUP ROOM IF PRESENT
    // --------------------------------------------------------

    if (currentHost.activeGroupRoomId) {
      const roomId = requireDocumentId(
        currentHost.activeGroupRoomId,
        "Active group room ID"
      );

      const roomRef = callRoomsCollection.doc(roomId);

      const roomSnapshot = await transaction.get(roomRef);

      if (
        !roomSnapshot.exists ||
        !roomHasCapacity(
          roomSnapshot.data(),
          currentHost.id
        )
      ) {
        return {
          matched: false,
          reason: "room_unavailable",
        };
      }
    } else if (currentHost.activeCallId) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // --------------------------------------------------------
    // WRITE REQUEST
    // --------------------------------------------------------

    const callData = {
      customerUid: userId,
      userId,
      hostId: currentHost.id,

      status: "matching",

      groupRoomId: null,
      roomId: null,
      roomUrl: null,

      createdAt: now,
      updatedAt: now,

      startedAt: null,
      endedAt: null,

      durationSeconds: 0,
      billableMinutes: 0,

      billingStatus: "pending",
      endReason: null,
    };

    transaction.create(callRef, callData);

    transaction.set(
      userRef,
      {
        activeCallId: callRef.id,
        updatedAt: now,
      },
      { merge: true }
    );

    return {
      matched: true,

      call: {
        id: callRef.id,
        ...callData,
      },

      host: getPublicHostProfile(currentHost),
    };
  });
}

// ============================================================
// MATCH CUSTOMER TO HOST
// ============================================================

/**
 * Finds an available host and creates one pending request.
 *
 * The final host acceptance transaction is responsible for
 * atomically reserving a participant slot in the group room.
 */
export async function matchUserToHost(userId) {
  userId = requireDocumentId(userId, "Customer ID");

  await validateUserForMatching(userId);

  const hostsSnapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const candidates = hostsSnapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const host of candidates) {
    let available = false;

    try {
      available = await isHostAvailable(host);
    } catch (error) {
      // A failed availability read must never make a host
      // appear available.
      console.error(
        "[SA LIVE] Host availability check failed:",
        host.id,
        error.message
      );

      continue;
    }

    if (!available) {
      continue;
    }

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
  }

  return {
    matched: false,
    message:
      "No available host was found. Please try again shortly.",
    retry: true,
  };
}
