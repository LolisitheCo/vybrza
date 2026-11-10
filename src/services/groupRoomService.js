
import crypto from "node:crypto";
import { db } from "../config/firebase.js";

// ============================================================
// SA LIVE — GROUP ROOM SERVICE
// One host + maximum five customers
// ============================================================

export const MAX_GROUP_CUSTOMERS = 5;
export const MAX_GROUP_PARTICIPANTS = 6;

const users = db.collection("users");
const hosts = db.collection("hosts");
const callSessions = db.collection("callSessions");
const callRooms = db.collection("callRooms");

const HOST_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_ID_LENGTH = 150;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const VALID_ROOM_NAME_PATTERN = /^salive-group-[A-Za-z0-9]+$/;

const TERMINAL_STATUSES = new Set([
  "ended",
  "completed",
  "cancelled",
  "canceled",
  "failed",
  "expired",
]);

// ============================================================
// HELPERS
// ============================================================

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeId(value, fieldName = "ID") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > MAX_ID_LENGTH ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw makeError(`A valid ${fieldName} is required.`);
  }

  return value.trim();
}

function isValidId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    VALID_ID_PATTERN.test(value)
  );
}

function timestampMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  const date = new Date(value).getTime();

  return Number.isFinite(date) ? date : 0;
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(value.filter(isValidId))];
}

function hasValidRoomMembership(room) {
  return (
    Array.isArray(room.customerIds) &&
    Array.isArray(room.callIds) &&
    room.customerIds.every(isValidId) &&
    room.callIds.every(isValidId) &&
    new Set(room.customerIds).size === room.customerIds.length &&
    new Set(room.callIds).size === room.callIds.length &&
    room.customerIds.length === room.callIds.length
  );
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

  return TERMINAL_STATUSES.has(
    String(call.status || "").toLowerCase()
  );
}

function isRecentlyActive(host, now = Date.now()) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = now - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
}

function makeRoomName() {
  return `salive-group-${crypto.randomUUID().replace(/-/g, "")}`;
}

function safeHost(hostId, data) {
  return {
    id: hostId,

    displayName:
      typeof data.displayName === "string" && data.displayName.trim()
        ? data.displayName.trim().slice(0, 80)
        : typeof data.name === "string" && data.name.trim()
          ? data.name.trim().slice(0, 80)
          : "SA LIVE Host",

    photoURL:
      typeof data.photoURL === "string"
        ? data.photoURL
        : typeof data.profilePicture === "string"
          ? data.profilePicture
          : null,
  };
}

function getRoomMaxCustomers() {
  return MAX_GROUP_CUSTOMERS;
}

function isValidGroupRoom(room, hostId) {
  if (!room || room.hostId !== hostId) {
    return false;
  }

  if (
    typeof room.roomName !== "string" ||
    !VALID_ROOM_NAME_PATTERN.test(room.roomName)
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) {
    return false;
  }

  if (!hasValidRoomMembership(room)) {
    return false;
  }

  return true;
}

function roomHasCapacity(room, hostId) {
  if (!isValidGroupRoom(room, hostId)) {
    return false;
  }

  return (
    room.customerIds.length < getRoomMaxCustomers()
  );
}

function makeRoomResponse(roomId, room, customerCount) {
  return {
    id: roomId,
    roomName: room.roomName,
    status: room.status,
    customerCount,
    maxCustomers: MAX_GROUP_CUSTOMERS,
    maxParticipants: MAX_GROUP_PARTICIPANTS,
  };
}

function isRequestExpired(call, now = Date.now()) {
  if (call?.status !== "matching") {
    return false;
  }

  const createdAt = timestampMillis(call.createdAt);

  return (
    createdAt > 0 &&
    now - createdAt >= REQUEST_TIMEOUT_MS
  );
}

async function getScheduleChecker() {
  const service = await import("./hostAvailabilityService.js");

  if (typeof service.isWithinHostSchedule !== "function") {
    throw makeError(
      "Host availability service is not configured.",
      500
    );
  }

  return service.isWithinHostSchedule;
}

// ============================================================
// HOST AVAILABILITY
// ============================================================

async function hostCanAcceptCalls(
  host,
  now = new Date()
) {
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

  if (!isRecentlyActive(host, now.getTime())) {
    return false;
  }

  const isWithinHostSchedule = await getScheduleChecker();

  try {
    return Boolean(
      await isWithinHostSchedule(host, now)
    );
  } catch (error) {
    console.error(
      "[SA LIVE] Host schedule validation failed:",
      error.message
    );

    return false;
  }
}

// ============================================================
// DEPRECATED COMPATIBILITY EXPORT
// ============================================================

export async function matchCustomerToGroupRoom() {
  throw makeError(
    "This function is deprecated. Create a matching request first, then let the host accept it.",
    410
  );
}

// ============================================================
// ATTACH EXISTING REQUEST TO GROUP ROOM
// ============================================================

export async function attachExistingCallToGroupRoom({
  callId,
  hostId,
}) {
  const normalizedCallId = normalizeId(
    callId,
    "call ID"
  );

  const normalizedHostId = normalizeId(
    hostId,
    "host ID"
  );

  const callRef = callSessions.doc(normalizedCallId);

  const isWithinHostSchedule = await getScheduleChecker();

  return db.runTransaction(async (transaction) => {
    // --------------------------------------------------------
    // READ 1 — CALL REQUEST
    // --------------------------------------------------------

    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      return {
        matched: false,
        message: "Call request not found.",
        retry: false,
      };
    }

    const call = callSnapshot.data();

    if (call.hostId !== normalizedHostId) {
      return {
        matched: false,
        message: "This call is not assigned to this host.",
        retry: false,
      };
    }

    // --------------------------------------------------------
    // IDEMPOTENT RESPONSE
    // --------------------------------------------------------

    if (
      call.groupRoomId &&
      ["matched", "active"].includes(call.status)
    ) {
      const existingRoomId = normalizeId(
        call.groupRoomId,
        "group room ID"
      );

      const existingRoomRef = callRooms.doc(
        existingRoomId
      );

      const existingRoomSnapshot = await transaction.get(
        existingRoomRef
      );

      if (!existingRoomSnapshot.exists) {
        return {
          matched: false,
          message: "The assigned group room no longer exists.",
          retry: false,
        };
      }

      const room = existingRoomSnapshot.data();

      const customerId = call.userId || call.customerUid;

      if (
        isValidGroupRoom(room, normalizedHostId) &&
        room.customerIds.includes(customerId) &&
        room.callIds.includes(normalizedCallId)
      ) {
        return {
          matched: true,
          alreadyAttached: true,
          message: "Call is already assigned to the group room.",

          call: {
            id: callSnapshot.id,
            ...call,
          },

          room: makeRoomResponse(
            existingRoomSnapshot.id,
            room,
            room.customerIds.length
          ),

          retry: false,
        };
      }

      return {
        matched: false,
        message: "The existing group-room assignment is inconsistent.",
        retry: false,
      };
    }

    // --------------------------------------------------------
    // VALIDATE REQUEST STATUS
    // --------------------------------------------------------

    if (
      call.status !== "matching" ||
      isTerminalCall(call)
    ) {
      return {
        matched: false,
        message: "This request is no longer waiting for host acceptance.",
        retry: false,
      };
    }

    if (isRequestExpired(call)) {
      return {
        matched: false,
        message: "This request has expired.",
        retry: false,
      };
    }

    const customerId = normalizeId(
      call.userId || call.customerUid,
      "customer ID"
    );

    if (customerId === normalizedHostId) {
      return {
        matched: false,
        message: "A host cannot accept their own request.",
        retry: false,
      };
    }

    // --------------------------------------------------------
    // READ 2 — CUSTOMER AND HOST
    // --------------------------------------------------------

    const userRef = users.doc(customerId);
    const hostRef = hosts.doc(normalizedHostId);

    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    if (!userSnapshot.exists) {
      return {
        matched: false,
        message: "Customer account not found.",
        retry: false,
      };
    }

    if (!hostSnapshot.exists) {
      return {
        matched: false,
        message: "Host account not found.",
        retry: false,
      };
    }

    const user = userSnapshot.data();
    const host = hostSnapshot.data();
    const now = new Date();

    // --------------------------------------------------------
    // CUSTOMER RESERVATION AND BALANCE
    // --------------------------------------------------------

    if (user.activeCallId !== normalizedCallId) {
      return {
        matched: false,
        message: "This customer request is no longer active.",
        retry: false,
      };
    }

    if (
      user.accountStatus &&
      user.accountStatus !== "active"
    ) {
      return {
        matched: false,
        message: "Customer account is not active.",
        retry: false,
      };
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      return {
        matched: false,
        message: "Customer does not have available minutes.",
        retry: false,
      };
    }

    // --------------------------------------------------------
    // HOST AVAILABILITY
    // --------------------------------------------------------

    let hostAvailable = false;

    try {
      hostAvailable =
        host.status === "active" &&
        typeof host.firebaseUid === "string" &&
        Boolean(host.firebaseUid.trim()) &&
        host.acceptingCalls === true &&
        isRecentlyActive(host, now.getTime()) &&
        Boolean(await isWithinHostSchedule(host, now));
    } catch (error) {
      console.error(
        "[SA LIVE] Host availability check failed:",
        error.message
      );
    }

    if (!hostAvailable) {
      return {
        matched: false,
        message: "Host is no longer available to accept calls.",
        retry: true,
      };
    }

    // --------------------------------------------------------
    // READ 3 — LEGACY ONE-TO-ONE RESERVATION
    // --------------------------------------------------------

    // Check this independently of activeGroupRoomId.
    // A host must never have a live one-to-one call and
    // a group room simultaneously.

    if (host.activeCallId) {
      const legacyCallId = normalizeId(
        host.activeCallId,
        "host active call ID"
      );

      const legacyCallRef = callSessions.doc(
        legacyCallId
      );

      const legacyCallSnapshot = await transaction.get(
        legacyCallRef
      );

      if (
        legacyCallSnapshot.exists &&
        !isTerminalCall(legacyCallSnapshot.data())
      ) {
        return {
          matched: false,
          message: "Host is currently reserved for another call.",
          retry: true,
        };
      }
    }

    // --------------------------------------------------------
    // READ 4 — CURRENT GROUP ROOM
    // --------------------------------------------------------

    let roomRef = null;
    let roomData = null;
    let createNewRoom = true;

    const proposedRoomRef = callRooms.doc();
    const proposedRoomName = makeRoomName();

    if (host.activeGroupRoomId) {
      const activeRoomId = normalizeId(
        host.activeGroupRoomId,
        "host group room ID"
      );

      const existingRoomRef = callRooms.doc(
        activeRoomId
      );

      const existingRoomSnapshot = await transaction.get(
        existingRoomRef
      );

      if (existingRoomSnapshot.exists) {
        const existingRoom = existingRoomSnapshot.data();

        if (existingRoom.hostId !== normalizedHostId) {
          return {
            matched: false,
            message: "The host's active room assignment is inconsistent.",
            retry: false,
          };
        }

        // A room can only be replaced after it has genuinely ended.
        if (
          existingRoom.status !== "ended" &&
          !existingRoom.endedAt
        ) {
          if (!isValidGroupRoom(existingRoom, normalizedHostId)) {
            return {
              matched: false,
              message: "The host's existing group room is invalid.",
              retry: false,
            };
          }

          const customerIds = existingRoom.customerIds;
          const callIds = existingRoom.callIds;

          if (
            customerIds.includes(customerId) ||
            callIds.includes(normalizedCallId)
          ) {
            return {
              matched: false,
              message: "The customer is already partially assigned to this room.",
              retry: false,
            };
          }

          if (
            customerIds.length >= MAX_GROUP_CUSTOMERS ||
            callIds.length >= MAX_GROUP_CUSTOMERS
          ) {
            return {
              matched: false,
              message: "This host's group room is full. Please try another host.",
              retry: true,
            };
          }

          roomRef = existingRoomRef;

          roomData = {
            ...existingRoom,
            customerIds,
            callIds,
          };

          createNewRoom = false;
        }
      }
    }

    // --------------------------------------------------------
    // LEGACY RESERVATION WITHOUT GROUP ROOM
    // --------------------------------------------------------

    // If no group room exists, the host may still have an old
    // one-to-one reservation pointer. It was checked above.
    // No second active call is allowed.

    if (createNewRoom) {
      roomRef = proposedRoomRef;
    }

    const roomName = createNewRoom
      ? proposedRoomName
      : roomData.roomName;

    // --------------------------------------------------------
    // ALL TRANSACTION READS ARE COMPLETE
    // BEGIN WRITES
    // --------------------------------------------------------

    if (createNewRoom) {
      transaction.create(roomRef, {
        hostId: normalizedHostId,
        roomName,

        status: "waiting_host",

        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,

        customerIds: [customerId],
        callIds: [normalizedCallId],

        createdAt: now,
        updatedAt: now,

        startedAt: null,
        endedAt: null,
      });
    } else {
      const nextCustomerIds = [
        ...roomData.customerIds,
        customerId,
      ];

      const nextCallIds = [
        ...roomData.callIds,
        normalizedCallId,
      ];

      if (
        nextCustomerIds.length > MAX_GROUP_CUSTOMERS ||
        nextCallIds.length > MAX_GROUP_CUSTOMERS
      ) {
        return {
          matched: false,
          message: "The group room has reached its customer limit.",
          retry: true,
        };
      }

      transaction.update(roomRef, {
        customerIds: nextCustomerIds,
        callIds: nextCallIds,
        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,
        updatedAt: now,
      });
    }

    transaction.update(hostRef, {
      activeGroupRoomId: roomRef.id,
      activeCallId: null,
      updatedAt: now,
    });

    transaction.update(callRef, {
      status: "matched",
      groupRoomId: roomRef.id,
      roomId: roomName,
      minutesAtStart: minutes,
      updatedAt: now,
    });

    return {
      matched: true,
      alreadyAttached: false,

      message: "Call accepted and assigned to the group room.",

      host: safeHost(normalizedHostId, host),

      call: {
        id: normalizedCallId,
        ...call,
        status: "matched",
        groupRoomId: roomRef.id,
        roomId: roomName,
        minutesAtStart: minutes,
        updatedAt: now,
      },

      room: makeRoomResponse(
        roomRef.id,
        {
          roomName,
          status: createNewRoom
            ? "waiting_host"
            : roomData.status,
        },
        createNewRoom
          ? 1
          : roomData.customerIds.length + 1
      ),

      retry: false,
    };
  });
}

// ============================================================
// CANCEL CUSTOMER MATCHING REQUEST
// ============================================================

export async function cancelMatchingCallRequest({
  callId,
  userId,
}) {
  const normalizedCallId = normalizeId(
    callId,
    "call ID"
  );

  const normalizedUserId = normalizeId(
    userId,
    "customer ID"
  );

  const callRef = callSessions.doc(normalizedCallId);
  const userRef = users.doc(normalizedUserId);

  return db.runTransaction(async (transaction) => {
    const [callSnapshot, userSnapshot] = await Promise.all([
      transaction.get(callRef),
      transaction.get(userRef),
    ]);

    if (!callSnapshot.exists) {
      return {
        cancelled: false,
        message: "Call request not found.",
      };
    }

    if (!userSnapshot.exists) {
      return {
        cancelled: false,
        message: "Customer account not found.",
      };
    }

    const call = callSnapshot.data();
    const user = userSnapshot.data();

    if (
      call.userId !== normalizedUserId &&
      call.customerUid !== normalizedUserId
    ) {
      return {
        cancelled: false,
        message: "This request does not belong to you.",
      };
    }

    if (call.status !== "matching") {
      return {
        cancelled: false,
        accepted: ["matched", "active"].includes(call.status),
        message: "This request is no longer waiting for acceptance.",
      };
    }

    const now = new Date();
    const expired = isRequestExpired(call, now.getTime());

    transaction.update(callRef, {
      status: expired ? "expired" : "cancelled",
      endedAt: now,
      updatedAt: now,
      endReason: expired ? "request_timeout" : "user_ended",
      durationSeconds: 0,
      minutesUsed: 0,
      billableMinutes: 0,
      billingStatus: "not_required",
    });

    if (user.activeCallId === normalizedCallId) {
      transaction.update(userRef, {
        activeCallId: null,
        updatedAt: now,
      });
    }

    return {
      cancelled: !expired,
      expired,
      callId: normalizedCallId,
      message: expired
        ? "The request had expired."
        : "Call request cancelled.",
    };
  });
}

// ============================================================
// REMOVE ONE CUSTOMER FROM A GROUP ROOM
// ============================================================

export async function removeCallFromGroupRoom({
  callId,
}) {
  const normalizedCallId = normalizeId(
    callId,
    "call ID"
  );

  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      return {
        removed: false,
        message: "Call not found.",
      };
    }

    const call = callSnapshot.data();
    const roomId = call.groupRoomId;

    if (!roomId || !isValidId(roomId)) {
      return {
        removed: false,
        message: "Call has no valid group room.",
      };
    }

    const roomRef = callRooms.doc(roomId);
    const hostId = call.hostId;
    const customerId = call.userId || call.customerUid;

    const [roomSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(roomRef),
      hostId
        ? transaction.get(hosts.doc(hostId))
        : Promise.resolve(null),
    ]);

    if (!roomSnapshot.exists) {
      return {
        removed: false,
        message: "Group room no longer exists.",
      };
    }

    const room = roomSnapshot.data();

    if (!isValidGroupRoom(room, hostId)) {
      return {
        removed: false,
        message: "Group room membership is invalid.",
      };
    }

    const customerIds = room.customerIds;
    const callIds = room.callIds;

    const nextCustomerIds = customerIds.filter(
      (id) => id !== customerId
    );

    const nextCallIds = callIds.filter(
      (id) => id !== normalizedCallId
    );

    const now = new Date();

    if (
      nextCustomerIds.length === 0 ||
      nextCallIds.length === 0
    ) {
      transaction.update(roomRef, {
        customerIds: [],
        callIds: [],
        status: "ended",
        endedAt: now,
        updatedAt: now,
      });

      if (
        hostSnapshot?.exists &&
        hostSnapshot.data().activeGroupRoomId === roomId
      ) {
        transaction.update(hostSnapshot.ref, {
          activeGroupRoomId: null,
          updatedAt: now,
        });
      }

      return {
        removed: true,
        roomEnded: true,
        remainingCustomers: 0,
      };
    }

    transaction.update(roomRef, {
      customerIds: nextCustomerIds,
      callIds: nextCallIds,
      updatedAt: now,
    });

    return {
      removed: true,
      roomEnded: false,
      remainingCustomers: nextCustomerIds.length,
    };
  });
}

// ============================================================
// GET GROUP ROOM
// ============================================================

export async function getGroupRoom(roomId) {
  const normalizedRoomId = normalizeId(
    roomId,
    "group room ID"
  );

  const snapshot = await callRooms
    .doc(normalizedRoomId)
    .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

// ============================================================
// GET GROUP ROOM FOR CALL
// ============================================================

export async function getGroupRoomForCall(callId) {
  const normalizedCallId = normalizeId(
    callId,
    "call ID"
  );

  const callSnapshot = await callSessions
    .doc(normalizedCallId)
    .get();

  if (!callSnapshot.exists) {
    return null;
  }

  const call = {
    id: callSnapshot.id,
    ...callSnapshot.data(),
  };

  if (!call.groupRoomId) {
    return null;
  }

  const room = await getGroupRoom(call.groupRoomId);

  if (!room) {
    return null;
  }

  return {
    callId: callSnapshot.id,
    call,
    room,
  };
}
