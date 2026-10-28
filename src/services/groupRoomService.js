
import crypto from "node:crypto";
import { db } from "../config/firebase.js";

export const MAX_GROUP_CUSTOMERS = 3;
export const MAX_GROUP_PARTICIPANTS = 4;

const users = db.collection("users");
const hosts = db.collection("hosts");
const callSessions = db.collection("callSessions");
const callRooms = db.collection("callRooms");

const HOST_TIMEOUT_MS = 45_000;

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
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();

  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function hostIsRecentlyActive(host) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = Date.now() - lastSeen;

  return lastSeen > 0 && age >= 0 && age <= HOST_TIMEOUT_MS;
}

function safeHost(hostId, data) {
  return {
    id: hostId,
    displayName: data.displayName || data.name || "SA LIVE Host",
    photoURL: data.photoURL || data.profilePicture || null,
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

function isTerminalCall(call) {
  if (!call) return true;
  if (call.endedAt) return true;

  return [
    "ended",
    "completed",
    "cancelled",
    "canceled",
    "failed",
  ].includes(String(call.status || "").toLowerCase());
}

function roomHasCapacity(room, hostId) {
  if (!room || room.hostId !== hostId) return false;
  if (
    typeof room.roomName !== "string" ||
    !room.roomName.startsWith("salive-group-")
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) return false;
  if (room.endedAt) return false;

  const customerIds = Array.isArray(room.customerIds)
    ? room.customerIds
    : [];

  const uniqueCustomerIds = [...new Set(customerIds)];
  const maxCustomers = Math.min(
    Number(room.maxCustomers ?? MAX_GROUP_CUSTOMERS),
    MAX_GROUP_CUSTOMERS
  );

  return (
    Number.isInteger(maxCustomers) &&
    maxCustomers > 0 &&
    uniqueCustomerIds.length < maxCustomers
  );
}

async function hostCanAcceptCalls(host, date = new Date()) {
  if (host.status !== "active" || !host.firebaseUid) return false;
  if (host.acceptingCalls !== true) return false;
  if (!hostIsRecentlyActive(host)) return false;

  const { isWithinHostSchedule } = await import(
    "./hostAvailabilityService.js"
  );

  return isWithinHostSchedule(host, date);
}

/**
 * Match a customer to a host's group room.
 *
 * Each customer has a separate callSessions document and balance.
 * A host can have one group room with up to three distinct customers.
 */
export async function matchCustomerToGroupRoom({ userId, hostId }) {
  if (!validId(userId) || !validId(hostId)) {
    throw new Error("A valid customer ID and host ID are required.");
  }

  const userRef = users.doc(userId);
  const hostRef = hosts.doc(hostId);
  const callRef = callSessions.doc();

  const proposedRoomRef = callRooms.doc();
  const proposedRoomName = makeRoomName();

  return db.runTransaction(async (transaction) => {
    // Read customer and host.
    const [userSnap, hostSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

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

    if (!(await hostCanAcceptCalls(host))) {
      return {
        matched: false,
        message: "Host is not currently available.",
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

    
   // Read the existing call now, but defer all writes until every
// required transaction read has completed.
let clearStaleCallPointer = false;

if (user.activeCallId) {
  const oldCallRef = callSessions.doc(user.activeCallId);
  const oldCallSnap = await transaction.get(oldCallRef);

  if (oldCallSnap.exists && !isTerminalCall(oldCallSnap.data())) {
    return {
      matched: false,
      message: "You already have an active call.",
      retry: false,
    };
  }

  clearStaleCallPointer = true;
}

    let roomRef = proposedRoomRef;
    let roomName = proposedRoomName;
    let roomData = null;
    let createNewRoom = true;

    if (host.activeGroupRoomId) {
      const existingRoomRef = callRooms.doc(host.activeGroupRoomId);
      const roomSnap = await transaction.get(existingRoomRef);

      if (roomSnap.exists) {
        const existingRoom = roomSnap.data();

        if (roomHasCapacity(
          {
            id: roomSnap.id,
            ...existingRoom,
          },
          hostId
        )) {
          const customerIds = [
            ...new Set(
              Array.isArray(existingRoom.customerIds)
                ? existingRoom.customerIds
                : []
            ),
          ];

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
            callIds: Array.isArray(existingRoom.callIds)
              ? existingRoom.callIds
              : [],
          };

          createNewRoom = false;
        } else {
          // Do not overwrite or silently discard a live room.
          return {
            matched: false,
            message: "The host's group room is full or unavailable.",
            retry: true,
          };
        }
      } else {
        // A dangling host room pointer must be cleaned up separately.
        return {
          matched: false,
          message: "The host's room record is missing. Room cleanup is required.",
          retry: false,
        };
      }
    }

    // A legacy one-to-one reservation is allowed only when it does not
    // point to a genuinely active, unrelated call.
    if (host.activeCallId) {
      const legacyCallRef = callSessions.doc(host.activeCallId);
      const legacyCallSnap = await transaction.get(legacyCallRef);

      if (legacyCallSnap.exists) {
        const legacyCall = legacyCallSnap.data();

        if (
          !isTerminalCall(legacyCall) &&
          !legacyCall.groupRoomId
        ) {
          return {
            matched: false,
            message: "Host is currently reserved for another call.",
            retry: true,
          };
        }

        if (
          !isTerminalCall(legacyCall) &&
          legacyCall.groupRoomId &&
          legacyCall.groupRoomId !== host.activeGroupRoomId
        ) {
          return {
            matched: false,
            message: "Host has a conflicting active call reservation.",
            retry: true,
          };
        }
      }
    }



    // All transaction reads are complete at this point.
// It is now safe to perform writes.
const now = new Date();

if (clearStaleCallPointer) {
  transaction.update(userRef, {
    activeCallId: null,
    updatedAt: now,
  });
}

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
        customerIds: [...roomData.customerIds, userId],
        callIds: [...roomData.callIds, callRef.id],
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
        status: createNewRoom ? "waiting_host" : roomData.status,
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

export async function getGroupRoom(roomId) {
  if (!validId(roomId)) {
    throw new Error("A valid group room ID is required.");
  }

  const roomSnap = await callRooms.doc(roomId).get();

  if (!roomSnap.exists) return null;

  return {
    id: roomSnap.id,
    ...roomSnap.data(),
  };
}

export async function getGroupRoomForCall(callId) {
  if (!validId(callId)) {
    throw new Error("A valid call ID is required.");
  }

  const callSnap = await callSessions.doc(callId).get();

  if (!callSnap.exists) return null;

  const call = callSnap.data();

  if (!call.groupRoomId) return null;

  const room = await getGroupRoom(call.groupRoomId);

  if (!room) return null;

  return {
    callId: callSnap.id,
    call,
    room,
  };
}
