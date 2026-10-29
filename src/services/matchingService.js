
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessionsCollection = db.collection("callSessions");
const callRoomsCollection = db.collection("callRooms");

const HOST_TIMEOUT_MS = 45_000;
const MAX_GROUP_CUSTOMERS = 3;

const TERMINAL_CALL_STATUSES = new Set([
  "ended",
  "completed",
  "cancelled",
  "canceled",
  "failed",
]);

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

function roomHasCapacity(room, hostId) {
  if (!room || room.hostId !== hostId) {
    return false;
  }

  if (
    typeof room.roomName !== "string" ||
    !room.roomName.startsWith("salive-group-")
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) {
    return false;
  }

  const customerIds = Array.isArray(room.customerIds)
    ? room.customerIds
    : [];

  const maxCustomers = Number(
    room.maxCustomers ?? MAX_GROUP_CUSTOMERS
  );

  if (
    !Number.isInteger(maxCustomers) ||
    maxCustomers < 1
  ) {
    return false;
  }

  return (
    customerIds.length <
    Math.min(maxCustomers, MAX_GROUP_CUSTOMERS)
  );
}

/**
 * Public host fields only.
 *
 * Never return private host information such as:
 * Firebase identifiers, email addresses, phone numbers,
 * payment details, identity documents or internal settings.
 */
function getPublicHostProfile(host) {
  return {
    id: host.id,
    displayName:
      host.displayName ||
      host.name ||
      host.username ||
      "SA LIVE Host",
    username: host.username || null,
    photoURL: host.photoURL || host.profilePicture || null,
    bio: host.bio || "",
  };
}

/**
 * Check customer eligibility.
 *
 * A dangling activeCallId is cleared only when its call
 * document is missing or the call is terminal.
 */
export async function validateUserForMatching(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    throw new Error("A valid customer ID is required.");
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("Customer account not found.");
    }

    const user = userSnapshot.data();
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

    const activeCallRef = callSessionsCollection.doc(
      user.activeCallId
    );

    const activeCallSnapshot = await transaction.get(
      activeCallRef
    );

    if (activeCallSnapshot.exists) {
      const activeCall = activeCallSnapshot.data();

      if (!isTerminalCall(activeCall)) {
        throw new Error(
          "You already have a call in progress. End it before starting another."
        );
      }
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

/**
 * Preflight host availability.
 *
 * The final reservation transaction checks the important
 * host and room conditions again before creating a request.
 */
async function isHostAvailable(host, date = new Date()) {
  if (!host || host.status !== "active") {
    return false;
  }

  if (!host.firebaseUid) {
    return false;
  }

  if (host.acceptingCalls !== true) {
    return false;
  }

  if (!hasRecentHeartbeat(host)) {
    return false;
  }

  if (!isWithinHostSchedule(host, date)) {
    return false;
  }

  // A host without a group room cannot already have a
  // legacy one-to-one reservation.
  if (!host.activeGroupRoomId) {
    return !host.activeCallId;
  }

  const roomSnapshot = await callRoomsCollection
    .doc(host.activeGroupRoomId)
    .get();

  if (!roomSnapshot.exists) {
    return false;
  }

  return roomHasCapacity(
    roomSnapshot.data(),
    host.id
  );
}

/**
 * Atomically create a customer request and reserve the
 * customer's activeCallId.
 *
 * IMPORTANT:
 * This function does NOT create a group room.
 * The host acceptance controller calls
 * attachExistingCallToGroupRoom() to attach this same
 * call request after the host accepts.
 */
async function createCallRequestForHost(userId, host) {
  const userRef = usersCollection.doc(userId);
  const hostRef = hostsCollection.doc(host.id);
  const callRef = callSessionsCollection.doc();

  return db.runTransaction(async (transaction) => {
    // -----------------------------
    // READ CUSTOMER
    // -----------------------------

    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("Customer account not found.");
    }

    const user = userSnapshot.data();
    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw new Error(
        "You need available minutes before starting a call."
      );
    }

    // -----------------------------
    // READ HOST
    // -----------------------------

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

    if (
      currentHost.status !== "active" ||
      !currentHost.firebaseUid ||
      currentHost.acceptingCalls !== true ||
      !hasRecentHeartbeat(currentHost) ||
      !isWithinHostSchedule(currentHost, new Date())
    ) {
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // -----------------------------
    // READ EXISTING CUSTOMER CALL
    // -----------------------------

    let oldCallSnapshot = null;

    if (user.activeCallId) {
      const oldCallRef = callSessionsCollection.doc(
        user.activeCallId
      );

      oldCallSnapshot = await transaction.get(oldCallRef);

      if (oldCallSnapshot.exists) {
        const oldCall = oldCallSnapshot.data();

        if (!isTerminalCall(oldCall)) {
          throw new Error(
            "You already have a call in progress. End it before starting another."
          );
        }
      }
    }

    // -----------------------------
    // READ CURRENT GROUP ROOM
    // -----------------------------

    let currentRoomSnapshot = null;

    if (currentHost.activeGroupRoomId) {
      const roomRef = callRoomsCollection.doc(
        currentHost.activeGroupRoomId
      );

      currentRoomSnapshot = await transaction.get(roomRef);

      if (
        !currentRoomSnapshot.exists ||
        !roomHasCapacity(
          currentRoomSnapshot.data(),
          currentHost.id
        )
      ) {
        return {
          matched: false,
          reason: "room_unavailable",
        };
      }
    } else if (currentHost.activeCallId) {
      // Do not assign a new request to a host whose
      // legacy one-to-one call is still reserved.
      return {
        matched: false,
        reason: "host_unavailable",
      };
    }

    // -----------------------------
    // ALL READS ARE COMPLETE
    // WRITES START HERE
    // -----------------------------

    const now = new Date();

    const callData = {
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

/**
 * Match a customer to an eligible host.
 *
 * Creates one pending call request. It does not create
 * a room or start a call.
 */
export async function matchUserToHost(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    throw new Error("A valid customer ID is required.");
  }

  // Check customer eligibility before searching for hosts.
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
    const available = await isHostAvailable(host);

    if (!available) {
      continue;
    }

    const result = await createCallRequestForHost(
      userId,
      host
    );

    if (result.matched) {
      return result;
    }

    // Another request may have occupied the room or
    // changed the host's availability. Try the next host.
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
