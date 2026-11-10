import crypto from "node:crypto";
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

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

  const result = new Date(value).getTime();

  return Number.isFinite(result) ? result : 0;
}

function hasValidRoomMembership(room) {
  if (
    !Array.isArray(room?.customerIds) ||
    !Array.isArray(room?.callIds)
  ) {
    return false;
  }

  const customerIds = room.customerIds;
  const callIds = room.callIds;

  return (
    customerIds.length === callIds.length &&
    customerIds.length <= MAX_GROUP_CUSTOMERS &&
    customerIds.every(isValidId) &&
    callIds.every(isValidId) &&
    new Set(customerIds).size === customerIds.length &&
    new Set(callIds).size === callIds.length
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
  const lastSeen = timestampMillis(host?.lastSeenAt);
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

function isValidGroupRoom(room, hostId) {
  return (
    Boolean(room) &&
    room.hostId === hostId &&
    typeof room.roomName === "string" &&
    VALID_ROOM_NAME_PATTERN.test(room.roomName) &&
    ["waiting_host", "active"].includes(room.status) &&
    !room.endedAt &&
    hasValidRoomMembership(room)
  );
}

function roomHasCapacity(room, hostId) {
  return (
    isValidGroupRoom(room, hostId) &&
    room.customerIds.length < MAX_GROUP_CUSTOMERS
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

// ============================================================
// HOST AVAILABILITY
// ============================================================

function hostCanAcceptCalls(host, now = new Date()) {
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

  try {
    return isWithinHostSchedule(host, now) === true;
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
  const normalizedCallId = normalizeId(callId, "call ID");
  const normalizedHostId = normalizeId(hostId, "host ID");

  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    // READ 1 — CALL

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

    const customerId = normalizeId(
      call.userId || call.customerUid,
      "customer ID"
    );

        // IDEMPOTENT ACCEPTANCE

    if (
      call.groupRoomId &&
      ["matched", "active"].includes(call.status)
    ) {
      const existingRoomId = normalizeId(
        call.groupRoomId,
        "group room ID"
      );

      const existingRoomRef = callRooms.doc(existingRoomId);
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

      // Read customer and host reservations.
      const userRef = users.doc(customerId);
      const hostRef = hosts.doc(normalizedHostId);

      const [userSnapshot, hostSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(hostRef),
      ]);

      if (!userSnapshot.exists || !hostSnapshot.exists) {
        return {
          matched: false,
          message: "Customer or host account not found.",
          retry: false,
        };
      }

      const room = existingRoomSnapshot.data();
      const user = userSnapshot.data();
      const host = hostSnapshot.data();

      if (
        !isValidGroupRoom(room, normalizedHostId) ||
        !room.customerIds.includes(customerId) ||
        !room.callIds.includes(normalizedCallId) ||
        room.customerIds.indexOf(customerId) !==
          room.callIds.indexOf(normalizedCallId)
      ) {
        return {
          matched: false,
          message: "The existing group-room assignment is inconsistent.",
          retry: false,
        };
      }

      if (user.activeCallId !== normalizedCallId) {
        return {
          matched: false,
          message: "Customer call reservation is inconsistent.",
          retry: false,
        };
      }

      if (host.activeGroupRoomId !== existingRoomId) {
        return {
          matched: false,
          message: "Host group-room reservation is inconsistent.",
          retry: false,
        };
      }

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

    // REQUEST STATUS AND TIMEOUT

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

    if (customerId === normalizedHostId) {
      return {
        matched: false,
        message: "A host cannot accept their own request.",
        retry: false,
      };
    }

    // READ 2 — CUSTOMER AND HOST

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

    // CUSTOMER RESERVATION

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

    // HOST AVAILABILITY

    if (!hostCanAcceptCalls(host, now)) {
      return {
        matched: false,
        message: "Host is no longer available to accept calls.",
        retry: true,
      };
    }

    // LEGACY ONE-TO-ONE RESERVATION

    if (host.activeCallId) {
      const legacyCallId = normalizeId(
        host.activeCallId,
        "host active call ID"
      );

      const legacyCallRef = callSessions.doc(legacyCallId);
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

    // CURRENT GROUP ROOM

    let roomRef;
    let roomData = null;
    let createNewRoom = true;

    const proposedRoomRef = callRooms.doc();
    const proposedRoomName = makeRoomName();

    if (host.activeGroupRoomId) {
      const activeRoomId = normalizeId(
        host.activeGroupRoomId,
        "host group room ID"
      );

      const existingRoomRef = callRooms.doc(activeRoomId);
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

          if (!roomHasCapacity(existingRoom, normalizedHostId)) {
            return {
              matched: false,
              message: "This host's group room is full.",
              retry: true,
            };
          }

          roomRef = existingRoomRef;
          roomData = existingRoom;
          createNewRoom = false;
        }
      }
    }

    if (createNewRoom) {
      roomRef = proposedRoomRef;
    }

    const roomName = createNewRoom
      ? proposedRoomName
      : roomData.roomName;

    // ALL READS COMPLETE — BEGIN WRITES

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
      transaction.update(roomRef, {
        customerIds: [...roomData.customerIds, customerId],
        callIds: [...roomData.callIds, normalizedCallId],
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

    const nextRoom = {
      roomName,
      status: createNewRoom ? "waiting_host" : roomData.status,
    };

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
        nextRoom,
        createNewRoom ? 1 : roomData.customerIds.length + 1
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
  const normalizedCallId = normalizeId(callId, "call ID");
  const normalizedUserId = normalizeId(userId, "customer ID");

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

export async function removeCallFromGroupRoom({ callId }) {
  const normalizedCallId = normalizeId(callId, "call ID");
  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      return {
        removed: false,
        alreadyRemoved: true,
        message: "Call no longer exists.",
      };
    }

    const call = callSnapshot.data();

    if (!isTerminalCall(call)) {
      throw makeError(
        "An active call cannot be removed from its group room.",
        409
      );
    }

    const roomId = call.groupRoomId;

    if (!roomId || !isValidId(roomId)) {
      return {
        removed: false,
        alreadyRemoved: true,
        message: "Call has no valid group room assignment.",
      };
    }

    const hostId = normalizeId(call.hostId, "host ID");
    const customerId = normalizeId(
      call.userId || call.customerUid,
      "customer ID"
    );

    const roomRef = callRooms.doc(roomId);
    const hostRef = hosts.doc(hostId);

    const [roomSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(hostRef),
    ]);

    const host = hostSnapshot.exists
      ? hostSnapshot.data()
      : null;

    // Helper: release only this room's host reservation.
    const releaseHostRoomReservation = (now) => {
      if (
        hostSnapshot.exists &&
        host?.activeGroupRoomId === roomId
      ) {
        transaction.update(hostRef, {
          activeGroupRoomId: null,
          updatedAt: now,
        });
      }
    };

    const now = new Date();

    // Missing room: clear a stale host pointer.
    if (!roomSnapshot.exists) {
      releaseHostRoomReservation(now);

      return {
        removed: false,
        alreadyRemoved: true,
        roomEnded: true,
        hostReservationReleased:
          host?.activeGroupRoomId === roomId,
      };
    }

    const room = roomSnapshot.data();

    if (room.hostId !== hostId) {
      throw makeError(
        "Group room belongs to a different host.",
        403
      );
    }

    // Already-ended room: clear a stale host pointer.
    if (room.status === "ended" || room.endedAt) {
      releaseHostRoomReservation(now);

      return {
        removed: false,
        alreadyRemoved: true,
        roomEnded: true,
        hostReservationReleased:
          host?.activeGroupRoomId === roomId,
      };
    }

    if (!isValidGroupRoom(room, hostId)) {
      throw makeError(
        "Group room membership is invalid.",
        409
      );
    }

    const customerIndex = room.customerIds.indexOf(customerId);
    const callIndex = room.callIds.indexOf(normalizedCallId);

    // Both entries absent: this call was already removed.
    if (customerIndex === -1 && callIndex === -1) {
      // Repair an empty, active room rather than leaving
      // the host reserved against an empty room.
      if (room.customerIds.length === 0) {
        transaction.update(roomRef, {
          status: "ended",
          endedAt: now,
          updatedAt: now,
        });

        releaseHostRoomReservation(now);

        return {
          removed: false,
          alreadyRemoved: true,
          roomEnded: true,
          remainingCustomers: 0,
        };
      }

      return {
        removed: false,
        alreadyRemoved: true,
        roomEnded: false,
        remainingCustomers: room.customerIds.length,
      };
    }

    if (
      customerIndex === -1 ||
      callIndex === -1 ||
      customerIndex !== callIndex
    ) {
      throw makeError(
        "Customer and call room membership do not match.",
        409
      );
    }

    const nextCustomerIds = room.customerIds.filter(
      (_, index) => index !== customerIndex
    );

    const nextCallIds = room.callIds.filter(
      (_, index) => index !== callIndex
    );

    // Last customer leaves: end room and release host.
    if (nextCustomerIds.length === 0) {
      transaction.update(roomRef, {
        customerIds: [],
        callIds: [],
        status: "ended",
        endedAt: now,
        updatedAt: now,
      });

      releaseHostRoomReservation(now);

      return {
        removed: true,
        alreadyRemoved: false,
        roomEnded: true,
        remainingCustomers: 0,
      };
    }

    // Other customers remain: keep host reserved.
    transaction.update(roomRef, {
      customerIds: nextCustomerIds,
      callIds: nextCallIds,
      updatedAt: now,
    });

    return {
      removed: true,
      alreadyRemoved: false,
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

  const snapshot = await callRooms.doc(normalizedRoomId).get();

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
  const normalizedCallId = normalizeId(callId, "call ID");

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