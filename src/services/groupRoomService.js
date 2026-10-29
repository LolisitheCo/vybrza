
import crypto from "node:crypto";
import { db } from "../config/firebase.js";

export const MAX_GROUP_CUSTOMERS = 3;
export const MAX_GROUP_PARTICIPANTS = 4;

const users = db.collection("users");
const hosts = db.collection("hosts");
const callSessions = db.collection("callSessions");
const callRooms = db.collection("callRooms");

const HOST_TIMEOUT_MS = 45_000;
const MAX_ID_LENGTH = 128;

const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const VALID_ROOM_NAME_PATTERN = /^salive-group-[A-Za-z0-9]+$/;

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
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : 0;
  }

  const result = new Date(value).getTime();

  return Number.isFinite(result) ? result : 0;
}

function hostIsRecentlyActive(host, now = Date.now()) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = now - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
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

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value.filter((id) => isValidId(id))
    ),
  ];
}

function getRoomMaxCustomers(room) {
  const configured = Number(room.maxCustomers);

  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return MAX_GROUP_CUSTOMERS;
  }

  return Math.min(configured, MAX_GROUP_CUSTOMERS);
}

function isValidGroupRoom(room, hostId) {
  if (!room || room.hostId !== hostId) return false;

  if (
    typeof room.roomName !== "string" ||
    !VALID_ROOM_NAME_PATTERN.test(room.roomName)
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) return false;

  return true;
}

function roomHasCapacity(room, hostId) {
  if (!isValidGroupRoom(room, hostId)) {
    return false;
  }

  const customerIds = normalizeIdArray(room.customerIds);
  const maxCustomers = getRoomMaxCustomers(room);

  return customerIds.length < maxCustomers;
}

async function hostCanAcceptCalls(
  host,
  isWithinHostSchedule,
  date = new Date()
) {
  if (host.status !== "active") return false;

  if (
    typeof host.firebaseUid !== "string" ||
    !host.firebaseUid.trim()
  ) {
    return false;
  }

  if (host.acceptingCalls !== true) return false;

  if (!hostIsRecentlyActive(host, date.getTime())) {
    return false;
  }

  return Boolean(
    await isWithinHostSchedule(host, date)
  );
}

async function loadScheduleChecker() {
  const { isWithinHostSchedule } = await import(
    "./hostAvailabilityService.js"
  );

  if (typeof isWithinHostSchedule !== "function") {
    throw makeError(
      "Host availability service is not configured.",
      500
    );
  }

  return isWithinHostSchedule;
}

function makeCallRoomResponse(roomId, room, customerCount) {
  return {
    id: roomId,
    roomName: room.roomName,
    status: room.status,
    customerCount,
    maxCustomers: MAX_GROUP_CUSTOMERS,
    maxParticipants: MAX_GROUP_PARTICIPANTS,
  };
}

/*
|--------------------------------------------------------------------------
| MATCH CUSTOMER TO GROUP ROOM
|--------------------------------------------------------------------------
|
| Creates a NEW customer call session and attaches it to a group room.
|
| Use this when the matching system has not created a call session yet.
|
*/

export async function matchCustomerToGroupRoom({
  userId,
  hostId,
}) {
  const normalizedUserId = normalizeId(userId, "customer ID");
  const normalizedHostId = normalizeId(hostId, "host ID");

  if (normalizedUserId === normalizedHostId) {
    throw makeError(
      "A customer cannot be matched to their own host account."
    );
  }

  const isWithinHostSchedule = await loadScheduleChecker();

  const userRef = users.doc(normalizedUserId);
  const hostRef = hosts.doc(normalizedHostId);

  const callRef = callSessions.doc();
  const proposedRoomRef = callRooms.doc();
  const proposedRoomName = makeRoomName();

  return db.runTransaction(async (transaction) => {
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
    const now = new Date();

    const hostAvailable = await hostCanAcceptCalls(
      host,
      isWithinHostSchedule,
      now
    );

    if (!hostAvailable) {
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

    if (user.activeCallId) {
      if (!isValidId(user.activeCallId)) {
        return {
          matched: false,
          message: "Your existing call reservation needs cleanup.",
          retry: false,
        };
      }

      const oldCallRef = callSessions.doc(user.activeCallId);
      const oldCallSnap = await transaction.get(oldCallRef);

      if (
        oldCallSnap.exists &&
        !isTerminalCall(oldCallSnap.data())
      ) {
        return {
          matched: false,
          message: "You already have an active call.",
          retry: false,
        };
      }
    }

    let roomRef = proposedRoomRef;
    let roomName = proposedRoomName;
    let roomData = null;
    let createNewRoom = true;

    if (host.activeGroupRoomId) {
      if (!isValidId(host.activeGroupRoomId)) {
        return {
          matched: false,
          message: "The host's room reference is invalid. Room cleanup is required.",
          retry: false,
        };
      }

      const existingRoomRef = callRooms.doc(
        host.activeGroupRoomId
      );

      const roomSnap = await transaction.get(existingRoomRef);

      if (!roomSnap.exists) {
        return {
          matched: false,
          message: "The host's room record is missing. Room cleanup is required.",
          retry: false,
        };
      }

      const existingRoom = roomSnap.data();
      const existingCustomerIds = normalizeIdArray(
        existingRoom.customerIds
      );

      if (existingCustomerIds.includes(normalizedUserId)) {
        return {
          matched: false,
          message: "You are already assigned to this group room.",
          retry: false,
        };
      }

      if (
        !roomHasCapacity(
          {
            ...existingRoom,
            customerIds: existingCustomerIds,
          },
          normalizedHostId
        )
      ) {
        return {
          matched: false,
          message: "The host's group room is full or unavailable.",
          retry: true,
        };
      }

      roomRef = existingRoomRef;
      roomName = existingRoom.roomName;

      roomData = {
        ...existingRoom,
        customerIds: existingCustomerIds,
        callIds: normalizeIdArray(existingRoom.callIds),
      };

      createNewRoom = false;
    }

    let clearStaleHostCallPointer = false;

    if (host.activeCallId) {
      if (!isValidId(host.activeCallId)) {
        clearStaleHostCallPointer = true;
      } else {
        const legacyCallRef = callSessions.doc(
          host.activeCallId
        );

        const legacyCallSnap = await transaction.get(
          legacyCallRef
        );

        if (!legacyCallSnap.exists) {
          clearStaleHostCallPointer = true;
        } else {
          const legacyCall = legacyCallSnap.data();

          if (isTerminalCall(legacyCall)) {
            clearStaleHostCallPointer = true;
          } else if (!legacyCall.groupRoomId) {
            return {
              matched: false,
              message: "Host is currently reserved for another call.",
              retry: true,
            };
          } else if (
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
    }

    const callData = {
      userId: normalizedUserId,
      hostId: normalizedHostId,

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
        hostId: normalizedHostId,
        roomName,

        status: "waiting_host",

        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,

        customerIds: [normalizedUserId],
        callIds: [callRef.id],

        createdAt: now,
        updatedAt: now,

        startedAt: null,
        endedAt: null,
      });

      const hostUpdate = {
        activeGroupRoomId: roomRef.id,
        updatedAt: now,
      };

      if (clearStaleHostCallPointer) {
        hostUpdate.activeCallId = null;
      }

      transaction.update(hostRef, hostUpdate);
    } else {
      transaction.update(roomRef, {
        customerIds: [
          ...roomData.customerIds,
          normalizedUserId,
        ],
        callIds: [
          ...roomData.callIds,
          callRef.id,
        ],
        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,
        updatedAt: now,
      });

      if (clearStaleHostCallPointer) {
        transaction.update(hostRef, {
          activeCallId: null,
          updatedAt: now,
        });
      }
    }

    transaction.create(callRef, callData);

    transaction.update(userRef, {
      activeCallId: callRef.id,
      updatedAt: now,
    });

    return {
      matched: true,
      host: safeHost(normalizedHostId, host),
      call: {
        id: callRef.id,
        ...callData,
      },
      room: makeCallRoomResponse(
        roomRef.id,
        {
          roomName,
          status: createNewRoom ? "waiting_host" : roomData.status,
        },
        createNewRoom ? 1 : roomData.customerIds.length + 1
      ),
      retry: false,
    };
  });
}

/*
|--------------------------------------------------------------------------
| ATTACH EXISTING CALL REQUEST TO GROUP ROOM
|--------------------------------------------------------------------------
|
| Use this when a callSessions document ALREADY EXISTS.
|
| This is the function the host's acceptCallRequest controller should use.
|
| It does not create another callSessions document.
| It preserves the original call ID.
|
*/

export async function attachExistingCallToGroupRoom({
  callId,
  hostId,
}) {
  const normalizedCallId = normalizeId(callId, "call ID");
  const normalizedHostId = normalizeId(hostId, "host ID");

  const isWithinHostSchedule = await loadScheduleChecker();

  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    /*
     * READ 1: Existing call request.
     */
    const callSnap = await transaction.get(callRef);

    if (!callSnap.exists) {
      return {
        matched: false,
        message: "Call request not found.",
        retry: false,
      };
    }

    const call = callSnap.data();

    if (call.hostId !== normalizedHostId) {
      return {
        matched: false,
        message: "This call is not assigned to this host.",
        retry: false,
      };
    }

    /*
     * Idempotent response for an already attached request.
     */
    if (
      call.groupRoomId &&
      ["matched", "active"].includes(call.status)
    ) {
      const existingRoomRef = callRooms.doc(call.groupRoomId);
      const existingRoomSnap = await transaction.get(existingRoomRef);

      if (existingRoomSnap.exists) {
        const existingRoom = existingRoomSnap.data();

        if (
          isValidGroupRoom(existingRoom, normalizedHostId) &&
          normalizeIdArray(existingRoom.callIds).includes(normalizedCallId) &&
          normalizeIdArray(existingRoom.customerIds).includes(call.userId)
        ) {
          return {
            matched: true,
            alreadyAttached: true,
            message: "Call is already assigned to the group room.",
            call: {
              id: callSnap.id,
              ...call,
            },
            room: makeCallRoomResponse(
              existingRoomSnap.id,
              existingRoom,
              normalizeIdArray(existingRoom.customerIds).length
            ),
            retry: false,
          };
        }
      }

      return {
        matched: false,
        message: "This call has an invalid or missing group-room assignment. Manual cleanup is required.",
        retry: false,
      };
    }

    if (call.status !== "matching") {
      return {
        matched: false,
        message: "This call request cannot be accepted in its current state.",
        retry: false,
      };
    }

    if (call.endedAt || isTerminalCall(call)) {
      return {
        matched: false,
        message: "This call request has already ended.",
        retry: false,
      };
    }

    const userId = normalizeId(call.userId, "customer ID");

    if (userId === normalizedHostId) {
      return {
        matched: false,
        message: "A host cannot accept their own call request.",
        retry: false,
      };
    }

    /*
     * READ 2: Customer and host.
     */
    const userRef = users.doc(userId);
    const hostRef = hosts.doc(normalizedHostId);

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
        retry: false,
      };
    }

    const user = userSnap.data();
    const host = hostSnap.data();
    const now = new Date();

    /*
     * READ 3: Validate host availability.
     */
    const hostAvailable = await hostCanAcceptCalls(
      host,
      isWithinHostSchedule,
      now
    );

    if (!hostAvailable) {
      return {
        matched: false,
        message: "Host is no longer available to accept calls.",
        retry: true,
      };
    }

    /*
     * READ 4: Validate customer balance.
     */
    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      return {
        matched: false,
        message: "Customer does not have available minutes.",
        retry: false,
      };
    }

    /*
     * READ 5: Validate customer's active call reservation.
     */
    if (user.activeCallId && user.activeCallId !== normalizedCallId) {
      if (!isValidId(user.activeCallId)) {
        return {
          matched: false,
          message: "Customer has an invalid active call reservation.",
          retry: false,
        };
      }

      const oldCallRef = callSessions.doc(user.activeCallId);
      const oldCallSnap = await transaction.get(oldCallRef);

      if (
        oldCallSnap.exists &&
        !isTerminalCall(oldCallSnap.data())
      ) {
        return {
          matched: false,
          message: "Customer already has another active call.",
          retry: false,
        };
      }
    }

    /*
     * READ 6: Resolve existing group room.
     */
    let roomRef = null;
    let roomData = null;
    let createNewRoom = true;

    const proposedRoomRef = callRooms.doc();
    const proposedRoomName = makeRoomName();

    if (host.activeGroupRoomId) {
      if (!isValidId(host.activeGroupRoomId)) {
        return {
          matched: false,
          message: "Host group-room reference is invalid. Cleanup is required.",
          retry: false,
        };
      }

      const existingRoomRef = callRooms.doc(
        host.activeGroupRoomId
      );

      const roomSnap = await transaction.get(existingRoomRef);

      if (!roomSnap.exists) {
        return {
          matched: false,
          message: "Host group-room record is missing. Cleanup is required.",
          retry: false,
        };
      }

      const existingRoom = roomSnap.data();
      const customerIds = normalizeIdArray(
        existingRoom.customerIds
      );
      const existingCallIds = normalizeIdArray(
        existingRoom.callIds
      );

      /*
       * A partially completed earlier operation can be repaired
       * without creating a duplicate customer session.
       */
      const alreadyMember = customerIds.includes(userId);
      const alreadyHasCall = existingCallIds.includes(normalizedCallId);

      if (alreadyMember && alreadyHasCall) {
        roomRef = existingRoomRef;
        roomData = {
          ...existingRoom,
          customerIds,
          callIds: existingCallIds,
        };
        createNewRoom = false;
      } else {
        if (alreadyMember || alreadyHasCall) {
          return {
            matched: false,
            message: "Group-room membership is inconsistent. Manual cleanup is required.",
            retry: false,
          };
        }

        if (
          !roomHasCapacity(
            {
              ...existingRoom,
              customerIds,
            },
            normalizedHostId
          )
        ) {
          return {
            matched: false,
            message: "The host's group room is full or unavailable.",
            retry: true,
          };
        }

        roomRef = existingRoomRef;
        roomData = {
          ...existingRoom,
          customerIds,
          callIds: existingCallIds,
        };
        createNewRoom = false;
      }
    } else if (host.activeCallId) {
      /*
       * Legacy one-to-one calls must not be mixed with group calls.
       */
      if (!isValidId(host.activeCallId)) {
        return {
          matched: false,
          message: "Host has an invalid legacy call reservation.",
          retry: false,
        };
      }

      const legacyCallRef = callSessions.doc(host.activeCallId);
      const legacyCallSnap = await transaction.get(legacyCallRef);

      if (
        legacyCallSnap.exists &&
        !isTerminalCall(legacyCallSnap.data())
      ) {
        return {
          matched: false,
          message: "Host is currently reserved for another call.",
          retry: true,
        };
      }
    }

    if (createNewRoom) {
      roomRef = proposedRoomRef;
    }

    /*
     * All transaction reads are now complete.
     * Perform writes only below this point.
     */

    const roomName = createNewRoom
      ? proposedRoomName
      : roomData.roomName;

    const updatedCall = {
      ...call,
      status: "matched",
      groupRoomId: roomRef.id,
      roomId: roomName,
      minutesAtStart: minutes,
      updatedAt: now,
    };

    if (createNewRoom) {
      transaction.create(roomRef, {
        hostId: normalizedHostId,
        roomName,

        status: "waiting_host",

        maxCustomers: MAX_GROUP_CUSTOMERS,
        maxParticipants: MAX_GROUP_PARTICIPANTS,

        customerIds: [userId],
        callIds: [normalizedCallId],

        createdAt: now,
        updatedAt: now,

        startedAt: null,
        endedAt: null,
      });

      const hostUpdate = {
        activeGroupRoomId: roomRef.id,
        updatedAt: now,
      };

      if (host.activeCallId) {
        hostUpdate.activeCallId = null;
      }

      transaction.update(hostRef, hostUpdate);
    } else {
      const customerIds = normalizeIdArray(roomData.customerIds);
      const callIds = normalizeIdArray(roomData.callIds);

      const nextCustomerIds = customerIds.includes(userId)
        ? customerIds
        : [...customerIds, userId];

      const nextCallIds = callIds.includes(normalizedCallId)
        ? callIds
        : [...callIds, normalizedCallId];

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

    transaction.update(callRef, {
      status: "matched",
      groupRoomId: roomRef.id,
      roomId: roomName,
      minutesAtStart: minutes,
      updatedAt: now,
    });

    transaction.update(userRef, {
      activeCallId: normalizedCallId,
      updatedAt: now,
    });

    return {
      matched: true,
      alreadyAttached: false,
      message: "Call accepted and attached to the group room.",
      host: safeHost(normalizedHostId, host),
      call: {
        id: normalizedCallId,
        ...updatedCall,
      },
      room: makeCallRoomResponse(
        roomRef.id,
        {
          roomName,
          status: createNewRoom ? "waiting_host" : roomData.status,
        },
        createNewRoom
          ? 1
          : normalizeIdArray(roomData.customerIds).includes(userId)
            ? normalizeIdArray(roomData.customerIds).length
            : normalizeIdArray(roomData.customerIds).length + 1
      ),
      retry: false,
    };
  });
}

/*
|--------------------------------------------------------------------------
| GET GROUP ROOM
|--------------------------------------------------------------------------
*/

export async function getGroupRoom(roomId) {
  const normalizedRoomId = normalizeId(
    roomId,
    "group room ID"
  );

  const roomSnap = await callRooms
    .doc(normalizedRoomId)
    .get();

  if (!roomSnap.exists) return null;

  return {
    id: roomSnap.id,
    ...roomSnap.data(),
  };
}

/*
|--------------------------------------------------------------------------
| GET GROUP ROOM FOR CALL
|--------------------------------------------------------------------------
*/

export async function getGroupRoomForCall(callId) {
  const normalizedCallId = normalizeId(
    callId,
    "call ID"
  );

  const callSnap = await callSessions
    .doc(normalizedCallId)
    .get();

  if (!callSnap.exists) return null;

  const call = {
    id: callSnap.id,
    ...callSnap.data(),
  };

  if (!call.groupRoomId) return null;

  const room = await getGroupRoom(call.groupRoomId);

  if (!room) return null;

  return {
    callId: callSnap.id,
    call,
    room,
  };
}
