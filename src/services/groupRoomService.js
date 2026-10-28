
import crypto from "node:crypto";
import { db } from "../config/firebase.js";

export const MAX_GROUP_CUSTOMERS = 3;
export const MAX_GROUP_PARTICIPANTS = 4;

const users = db.collection("users");
const hosts = db.collection("hosts");
const callSessions = db.collection("callSessions");
const callRooms = db.collection("callRooms");

function validId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function timestampMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function hostIsRecentlyActive(host) {
  const lastSeen = timestampMillis(host.lastSeenAt);

  return (
    lastSeen > 0 &&
    Date.now() - lastSeen <= 45_000
  );
}

function safeHost(hostId, data) {
  return {
    id: hostId,
    displayName:
      data.displayName ||
      data.name ||
      "SA LIVE Host",
    photoURL:
      data.photoURL ||
      data.profilePicture ||
      null,
  };
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    return null;
  }

  return minutes;
}

function makeRoomName() {
  return `salive-group-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Assigns one customer to a host's shared group room.
 *
 * Each customer gets a separate callSessions document.
 * All customers assigned to the same host room share its LiveKit roomName.
 *
 * Capacity:
 *   1 host
 *   Up to 3 customers
 *
 * IMPORTANT:
 * This service creates assignments only. LiveKit token generation,
 * call start/end handling, webhook processing and billing lifecycle
 * must also support group rooms before deploying the complete feature.
 */
export async function matchCustomerToGroupRoom({ userId, hostId }) {
  if (!validId(userId) || !validId(hostId)) {
    throw new Error(
      "A valid customer ID and host ID are required."
    );
  }

  const userRef = users.doc(userId);
  const hostRef = hosts.doc(hostId);
  const callRef = callSessions.doc();

  // Prepared outside the transaction callback so Firestore retries
  // don't generate a different room ID for the same transaction attempt.
  const proposedRoomRef = callRooms.doc();
  const proposedRoomName = makeRoomName();

  return db.runTransaction(async (transaction) => {
    // Read user and host first.
    const userSnap = await transaction.get(userRef);
    const hostSnap = await transaction.get(hostRef);

    if (!userSnap.exists) {
      return {
        matched: false,
        message: "Customer account not found.",
        retry: false,
      };
    }

    if (!hostSnap.exists) {
      return {
        matched: false,
        message: "Host account not found.",
        retry: true,
      };
    }

    const user = userSnap.data();
    const host = hostSnap.data();

    if (host.status !== "active" || !host.firebaseUid) {
      return {
        matched: false,
        message: "Host is not active.",
        retry: true,
      };
    }

    if (!hostIsRecentlyActive(host)) {
      return {
        matched: false,
        message: "Host is not currently available.",
        retry: true,
      };
    }

    // A legacy one-to-one call reserves the host separately.
    if (host.activeCallId) {
      return {
        matched: false,
        message: "Host is currently reserved for another call.",
        retry: true,
      };
    }

    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      return {
        matched: false,
        message: "You need available minutes before starting a call.",
        retry: false,
      };
    }

    if (user.activeCallId) {
      return {
        matched: false,
        message: "You already have an active call.",
        retry: false,
      };
    }

    let roomRef = proposedRoomRef;
    let roomName = proposedRoomName;
    let roomData = null;
    let createNewRoom = true;

    // If the host already owns a room, read it before writing anything.
    if (host.activeGroupRoomId) {
      const existingRoomRef = callRooms.doc(
        host.activeGroupRoomId
      );

      const roomSnap = await transaction.get(existingRoomRef);

      if (!roomSnap.exists) {
        return {
          matched: false,
          message:
            "The host's room record is missing. Room cleanup is required.",
          retry: false,
        };
      }

      const existingRoom = roomSnap.data();

      const customerIds = Array.isArray(existingRoom.customerIds)
        ? existingRoom.customerIds
        : [];

      const callIds = Array.isArray(existingRoom.callIds)
        ? existingRoom.callIds
        : [];

      const roomIsJoinable =
        existingRoom.hostId === hostId &&
        typeof existingRoom.roomName === "string" &&
        existingRoom.roomName.startsWith("salive-group-") &&
        ["waiting_host", "active"].includes(existingRoom.status) &&
        !existingRoom.endedAt &&
        customerIds.length < MAX_GROUP_CUSTOMERS;

      if (!roomIsJoinable) {
        return {
          matched: false,
          message:
            "The host's group room is full or unavailable.",
          retry: true,
        };
      }

      if (customerIds.includes(userId)) {
        return {
          matched: false,
          message: "You are already assigned to this group room.",
          retry: false,
        };
      }

      roomRef = existingRoomRef;
      roomName = existingRoom.roomName;

      roomData = {
        ...existingRoom,
        customerIds,
        callIds,
      };

      createNewRoom = false;
    }

    const now = new Date();

    // One individual call record per customer preserves independent
    // duration, balance deductions, call history and host earnings.
    const callData = {
      userId,
      hostId,

      groupRoomId: roomRef.id,
      roomId: roomName,

      status: "matched",

      startedAt: null,
      endedAt: null,

      durationSeconds: 0,
      minutesUsed: 0,
      billableMinutes: 0,

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

      minutesAtStart: minutes,

      createdAt: now,
      updatedAt: now,
    };

    if (createNewRoom) {
      transaction.create(roomRef, {
        hostId,
        roomName,

        status: "waiting_host",

        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,

        customerIds: [userId],
        callIds: [callRef.id],

        createdAt: now,
        updatedAt: now,

        startedAt: null,
        endedAt: null,
      });

      transaction.update(hostRef, {
        activeGroupRoomId: roomRef.id,
        updatedAt: now,
      });
    } else {
      transaction.update(roomRef, {
        customerIds: [
          ...roomData.customerIds,
          userId,
        ],

        callIds: [
          ...roomData.callIds,
          callRef.id,
        ],

        updatedAt: now,
      });
    }

    transaction.create(callRef, callData);

    transaction.update(userRef, {
      activeCallId: callRef.id,
      updatedAt: now,
    });

    return {
      matched: true,

      host: safeHost(hostId, host),

      call: {
        id: callRef.id,
        ...callData,
      },

      room: {
        id: roomRef.id,
        roomName,

        status: createNewRoom
          ? "waiting_host"
          : roomData.status,

        customerCount: createNewRoom
          ? 1
          : roomData.customerIds.length + 1,

        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,
      },

      retry: false,
    };
  });
}

/**
 * Reads a group room by Firestore document ID.
 */
export async function getGroupRoom(roomId) {
  if (!validId(roomId)) {
    throw new Error("A valid group room ID is required.");
  }

  const roomSnap = await callRooms.doc(roomId).get();

  if (!roomSnap.exists) {
    return null;
  }

  return {
    id: roomSnap.id,
    ...roomSnap.data(),
  };
}

/**
 * Returns a group's current customer/call assignment information.
 * Do not expose this result publicly without authorization checks.
 */
export async function getGroupRoomForCall(callId) {
  if (!validId(callId)) {
    throw new Error("A valid call ID is required.");
  }

  const callSnap = await callSessions.doc(callId).get();

  if (!callSnap.exists) {
    return null;
  }

  const call = callSnap.data();

  if (!call.groupRoomId) {
    return null;
  }

  const room = await getGroupRoom(call.groupRoomId);

  if (!room) {
    return null;
  }

  return {
    callId: callSnap.id,
    call,
    room,
  };
}
