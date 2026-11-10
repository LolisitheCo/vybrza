import express from "express";
import {
  AccessToken,
  RoomServiceClient,
} from "livekit-server-sdk";

import { db } from "../config/firebase.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

import {
  startCall,
  endCall,
} from "../services/callService.js";

import {
  getGroupRoomForCall,
} from "../services/groupRoomService.js";

// ============================================================
// SA LIVE — LIVEKIT ROUTES
// One host + maximum five customers
// Maximum participants: six
// ============================================================

const router = express.Router();

router.use(verifyFirebaseToken);

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

const MAX_GROUP_PARTICIPANTS = 6;
const MAX_GROUP_CUSTOMERS = 5;

const JOIN_RESERVATION_MS = 120_000;
const TOKEN_TTL = "90s";

const VALID_ID = /^[A-Za-z0-9_-]{1,150}$/;

const ACTIVE_CALL_STATUSES = new Set([
  "matched",
  "active",
]);

const ALLOWED_END_REASONS = new Set([
  "completed",
  "user_ended",
  "host_ended",
  "connection_lost",
  "insufficient_balance",
  "admin_ended",
  "system_error",
]);

// ============================================================
// ERROR HELPERS
// ============================================================

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName = "ID") {
  if (
    typeof value !== "string" ||
    !VALID_ID.test(value.trim())
  ) {
    throw httpError(
      400,
      `A valid ${fieldName} is required.`
    );
  }

  return value.trim();
}

function getCallId(req) {
  return validateId(
    req.body?.callId,
    "callId"
  );
}

function getFirebaseUid(req) {
  return validateId(
    req.user?.uid,
    "Firebase user ID"
  );
}

function noStore(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
}

// ============================================================
// LIVEKIT CONFIGURATION
// ============================================================

function getLiveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit server configuration is missing."
    );
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("LIVEKIT_URL is invalid.");
  }

  if (
    !["https:", "wss:"].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash
  ) {
    throw new Error(
      "LIVEKIT_URL must be a secure LiveKit URL."
    );
  }

  return {
    url: parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret,
  };
}

function getRoomService() {
  const config = getLiveKitConfig();

  const parsedUrl = new URL(config.url);

  if (parsedUrl.protocol === "wss:") {
    parsedUrl.protocol = "https:";
  }

  return new RoomServiceClient(
    parsedUrl.toString().replace(/\/+$/, ""),
    config.apiKey,
    config.apiSecret
  );
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function getRoomName(call) {
  if (
    typeof call.roomId === "string" &&
    call.roomId.trim()
  ) {
    return call.roomId.trim();
  }

  if (call.groupRoomId) {
    throw httpError(
      409,
      "The group call has no assigned LiveKit room name."
    );
  }

  return `salive-${call.id}`;
}

function toMillis(value) {
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

function isMissingRoomError(error) {
  const message = String(
    error?.message || ""
  ).toLowerCase();

  return (
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("room_not_found")
  );
}

function validateRoomMembership(room) {
  if (
    !Array.isArray(room?.customerIds) ||
    !Array.isArray(room?.callIds)
  ) {
    return false;
  }

  const customers = room.customerIds;
  const calls = room.callIds;

  return (
    customers.length === calls.length &&
    customers.length <= MAX_GROUP_CUSTOMERS &&
    customers.every(
      (id) =>
        typeof id === "string" &&
        VALID_ID.test(id)
    ) &&
    calls.every(
      (id) =>
        typeof id === "string" &&
        VALID_ID.test(id)
    ) &&
    new Set(customers).size === customers.length &&
    new Set(calls).size === calls.length
  );
}

function getMembershipIndex(room, callId, customerId) {
  if (!validateRoomMembership(room)) {
    return -1;
  }

  const customerIndex =
    room.customerIds.indexOf(customerId);

  const callIndex =
    room.callIds.indexOf(callId);

  if (
    customerIndex === -1 ||
    callIndex === -1 ||
    customerIndex !== callIndex
  ) {
    return -1;
  }

  return customerIndex;
}

function noCacheResponse(res) {
  noStore(res);
}

// ============================================================
// LIVEKIT PARTICIPANTS
// ============================================================

async function getRoomParticipants(roomName) {
  try {
    return await getRoomService().listParticipants(
      roomName
    );
  } catch (error) {
    if (isMissingRoomError(error)) {
      return [];
    }

    throw error;
  }
}

async function removeLiveKitParticipant(
  roomName,
  identity
) {
  if (
    typeof roomName !== "string" ||
    !roomName.trim() ||
    typeof identity !== "string" ||
    !identity.trim()
  ) {
    return {
      removed: false,
      reason: "invalid_arguments",
    };
  }

  const roomService = getRoomService();

  const participants = await getRoomParticipants(
    roomName
  );

  const exists = participants.some(
    (participant) =>
      participant.identity === identity
  );

  if (!exists) {
    return {
      removed: false,
      reason: "participant_not_present",
    };
  }

  await roomService.removeParticipant(
    roomName,
    identity
  );

  return {
    removed: true,
  };
}

// ============================================================
// CALL AUTHORIZATION
// ============================================================

async function getAuthorizedCall(callId, firebaseUid) {
  const snapshot = await callSessions
    .doc(callId)
    .get();

  if (!snapshot.exists) {
    throw httpError(
      404,
      "Call session not found."
    );
  }

  const call = {
    id: snapshot.id,
    ...snapshot.data(),
  };

  const customerId =
    call.userId || call.customerUid;

  const isCustomer =
    customerId === firebaseUid;

  let isAssignedHost = false;
  let hostData = null;

  if (
    typeof call.hostId === "string" &&
    call.hostId
  ) {
    const hostSnapshot = await hosts
      .doc(call.hostId)
      .get();

    if (hostSnapshot.exists) {
      hostData = hostSnapshot.data();

      isAssignedHost =
        hostData.firebaseUid === firebaseUid &&
        hostData.status === "active";
    }
  }

  if (!isCustomer && !isAssignedHost) {
    throw httpError(
      403,
      "You are not a participant in this call."
    );
  }

  return {
    call,
    isCustomer,
    isAssignedHost,
    hostData,
  };
}

// ============================================================
// GROUP ROOM AUTHORIZATION
// ============================================================

async function verifyGroupRoomMembership({
  callId,
  call,
  firebaseUid,
  isCustomer,
  isAssignedHost,
  hostData,
}) {
  const result = await getGroupRoomForCall(callId);

  const room = result?.room;

  if (
    !result ||
    result.callId !== callId ||
    !room ||
    room.id !== call.groupRoomId ||
    !room.roomName ||
    room.roomName !== call.roomId ||
    !["waiting_host", "active"].includes(room.status) ||
    room.endedAt
  ) {
    throw httpError(
      409,
      "This group room is no longer available."
    );
  }

  if (room.hostId !== call.hostId) {
    throw httpError(
      403,
      "This group room belongs to another host."
    );
  }

  if (!validateRoomMembership(room)) {
    throw httpError(
      409,
      "Group room membership is invalid."
    );
  }

  if (isCustomer) {
    const customerId =
      call.userId || call.customerUid;

    if (
      customerId !== firebaseUid ||
      getMembershipIndex(
        room,
        callId,
        firebaseUid
      ) === -1
    ) {
      throw httpError(
        403,
        "You are not a valid member of this group room."
      );
    }
  }

  if (isAssignedHost) {
    if (
      !hostData?.firebaseUid ||
      hostData.firebaseUid !== firebaseUid
    ) {
      throw httpError(
        403,
        "You are not authorized to join this host room."
      );
    }
  }

  return room;
}

// ============================================================
// GROUP ROOM JOIN RESERVATION
// ============================================================

async function reserveGroupRoomSlot({
  groupRoomId,
  roomName,
  identity,
  callId,
  hostId,
  isHost,
}) {
  const roomRef = callRooms.doc(groupRoomId);
  const hostRef = hosts.doc(hostId);

  // Check actual LiveKit presence before the transaction.
  const liveParticipants = await getRoomParticipants(
    roomName
  );

  const liveIdentities = new Set(
    liveParticipants
      .map((participant) => participant.identity)
      .filter(
        (value) => typeof value === "string"
      )
  );

  return db.runTransaction(async (transaction) => {
    const [roomSnapshot, hostSnapshot] =
      await Promise.all([
        transaction.get(roomRef),
        transaction.get(hostRef),
      ]);

    if (!roomSnapshot.exists) {
      throw httpError(
        404,
        "Group room not found."
      );
    }

    if (!hostSnapshot.exists) {
      throw httpError(
        404,
        "Assigned host not found."
      );
    }

    const room = roomSnapshot.data();
    const host = hostSnapshot.data();

    if (
      room.hostId !== hostId ||
      room.roomName !== roomName ||
      !["waiting_host", "active"].includes(room.status) ||
      room.endedAt
    ) {
      throw httpError(
        409,
        "This group room is no longer available."
      );
    }

    if (
      host.activeGroupRoomId !== groupRoomId
    ) {
      throw httpError(
        409,
        "The host's group room reservation is invalid."
      );
    }

    if (!validateRoomMembership(room)) {
      throw httpError(
        409,
        "Group room membership is invalid."
      );
    }

    if (isHost) {
      if (
        host.firebaseUid !== identity ||
        host.status !== "active"
      ) {
        throw httpError(
          403,
          "You are not authorized to join this host room."
        );
      }
    } else {
      const membershipIndex =
        getMembershipIndex(
          room,
          callId,
          identity
        );

      if (membershipIndex === -1) {
        throw httpError(
          403,
          "You are not registered in this group room."
        );
      }
    }

    const now = Date.now();

    const existingReservations = Array.isArray(
      room.joinReservations
    )
      ? room.joinReservations
      : [];

    const activeReservations =
      existingReservations.filter(
        (reservation) => {
          return (
            reservation &&
            typeof reservation.identity === "string" &&
            toMillis(reservation.expiresAt) > now
          );
        }
      );

    const occupiedIdentities = new Set(
      liveIdentities
    );

    for (const reservation of activeReservations) {
      occupiedIdentities.add(
        reservation.identity
      );
    }

    const alreadyCounted =
      occupiedIdentities.has(identity);

    if (
      !alreadyCounted &&
      occupiedIdentities.size >= MAX_GROUP_PARTICIPANTS
    ) {
      throw httpError(
        409,
        "This call room is full."
      );
    }

    const expiresAt = new Date(
      now + JOIN_RESERVATION_MS
    );

    const nextReservations =
      activeReservations.filter(
        (reservation) =>
          reservation.identity !== identity
      );

    nextReservations.push({
      identity,
      callId: isHost ? null : callId,
      expiresAt,
    });

    transaction.update(roomRef, {
      joinReservations: nextReservations,
      updatedAt: new Date(),
    });

    return {
      reserved: true,
      expiresAt,
      participantCount:
        occupiedIdentities.size +
        (alreadyCounted ? 0 : 1),
    };
  });
}

// ============================================================
// POST /api/livekit/token
// ============================================================

router.post("/token", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const firebaseUid = getFirebaseUid(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
      hostData,
    } = await getAuthorizedCall(
      callId,
      firebaseUid
    );

    if (!ACTIVE_CALL_STATUSES.has(call.status)) {
      throw httpError(
        409,
        "This call is not ready to join."
      );
    }

    const {
      url,
      apiKey,
      apiSecret,
    } = getLiveKitConfig();

    let roomName = getRoomName(call);

    if (call.groupRoomId) {
      const room =
        await verifyGroupRoomMembership({
          callId,
          call,
          firebaseUid,
          isCustomer,
          isAssignedHost,
          hostData,
        });

      roomName = room.roomName;

      await reserveGroupRoomSlot({
        groupRoomId: call.groupRoomId,
        roomName,
        identity: firebaseUid,
        callId,
        hostId: call.hostId,
        isHost: isAssignedHost,
      });
    } else {
      const participants =
        await getRoomParticipants(roomName);

      const alreadyPresent = participants.some(
        (participant) =>
          participant.identity === firebaseUid
      );

      if (
        !alreadyPresent &&
        participants.length >= 2
      ) {
        throw httpError(
          409,
          "This call room is full."
        );
      }
    }

    const token = new AccessToken(
      apiKey,
      apiSecret,
      {
        identity: firebaseUid,
        ttl: TOKEN_TTL,

        metadata: JSON.stringify({
          callId,
          role: isCustomer ? "customer" : "host",
          groupRoomId: call.groupRoomId || null,
        }),
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    noCacheResponse(res);

    return res.status(200).json({
      success: true,
      serverUrl: url,
      roomName,
      token: await token.toJwt(),
      callId,
      groupRoomId: call.groupRoomId || null,
    });
  } catch (error) {
    return next(error);
  }
});

// ============================================================
// POST /api/livekit/start
// ============================================================

router.post("/start", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const firebaseUid = getFirebaseUid(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
      hostData,
    } = await getAuthorizedCall(
      callId,
      firebaseUid
    );

    if (!ACTIVE_CALL_STATUSES.has(call.status)) {
      throw httpError(
        409,
        "This call is not ready to start."
      );
    }

    if (!hostData?.firebaseUid) {
      throw httpError(
        409,
        "The assigned host is unavailable."
      );
    }

    let roomName = getRoomName(call);

    if (call.groupRoomId) {
      const room =
        await verifyGroupRoomMembership({
          callId,
          call,
          firebaseUid,
          isCustomer,
          isAssignedHost,
          hostData,
        });

      roomName = room.roomName;
    }

    const participants =
      await getRoomParticipants(roomName);

    const identities = new Set(
      participants
        .map((participant) => participant.identity)
        .filter(
          (identity) =>
            typeof identity === "string"
        )
    );

    const customerIdentity =
      call.userId || call.customerUid;

    if (
      !customerIdentity ||
      !identities.has(customerIdentity) ||
      !identities.has(hostData.firebaseUid)
    ) {
      throw httpError(
        409,
        "Both the assigned customer and host must be present in the room."
      );
    }

    const { url } = getLiveKitConfig();

    const result = await startCall(
      callId,
      roomName,
      url
    );

    noCacheResponse(res);

    return res.status(200).json({
      success: true,
      message: "Call is active.",
      call: result,
    });
  } catch (error) {
    return next(error);
  }
});

// ============================================================
// END CUSTOMER SESSION
// ============================================================

async function endCustomerSession(
  callId,
  call,
  firebaseUid,
  reason
) {
  const roomName = getRoomName(call);

  let result;
  let operationError;

  try {
    result = await endCall(callId, reason);
  } catch (error) {
    operationError = error;
  }

  // Remove only this customer from the shared room.
  try {
    await removeLiveKitParticipant(
      roomName,
      firebaseUid
    );
  } catch (error) {
    console.error(
      "[SA LIVE] Customer disconnection failed:",
      {
        callId,
        message: error.message,
      }
    );

    if (!operationError) {
      operationError = httpError(
        503,
        "The call has ended, but the video connection could not be closed."
      );
    }
  }

  if (operationError) {
    throw operationError;
  }

  return result;
}

// ============================================================
// END HOST GROUP SESSION
// ============================================================

async function endHostGroupSession(
  call,
  callId,
  reason
) {
  const groupRoomId = validateId(
    call.groupRoomId,
    "group room ID"
  );

  const roomRef = callRooms.doc(groupRoomId);

  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists) {
    throw httpError(
      409,
      "The group room document no longer exists. Manual cleanup is required."
    );
  }

  const roomData = roomSnapshot.data();

  if (
    roomData.hostId !== call.hostId ||
    typeof roomData.roomName !== "string" ||
    !roomData.roomName.trim()
  ) {
    throw httpError(
      409,
      "The group room assignment is invalid."
    );
  }

  const roomName = roomData.roomName;

  if (!validateRoomMembership(roomData)) {
    throw httpError(
      409,
      "Group room membership is invalid."
    );
  }

  // Capture the call IDs before ending sessions.
  const callIds = [...roomData.callIds];

  if (!callIds.includes(callId)) {
    callIds.push(callId);
  }

  const endedCalls = [];
  const billingFailures = [];
  const finalizationFailures = [];

  // End each customer's call independently.

  for (const groupCallId of callIds) {
    const groupCallSnapshot = await callSessions
      .doc(groupCallId)
      .get();

    if (!groupCallSnapshot.exists) {
      continue;
    }

    const groupCall = groupCallSnapshot.data();

    if (
      groupCall.hostId !== call.hostId ||
      groupCall.groupRoomId !== groupRoomId
    ) {
      finalizationFailures.push({
        callId: groupCallId,
        message: "Call does not belong to this group room.",
      });

      continue;
    }

    const shouldProcess =
      ["matching", "matched", "active"].includes(
        groupCall.status
      ) ||
      (
        groupCall.status === "completed" &&
        groupCall.billingStatus !== "finalized" &&
        groupCall.billingStatus !== "not_required"
      );

    if (!shouldProcess) {
      continue;
    }

    try {
      const ended = await endCall(
        groupCallId,
        reason
      );

      endedCalls.push(ended);
    } catch (error) {
      const latestSnapshot = await callSessions
        .doc(groupCallId)
        .get();

      const latestCall = latestSnapshot.exists
        ? latestSnapshot.data()
        : null;

      if (
        latestCall?.status === "completed" &&
        latestCall?.billingStatus === "pending"
      ) {
        billingFailures.push({
          callId: groupCallId,
          message:
            String(error.message || "Billing pending").slice(0, 250),
        });
      } else {
        finalizationFailures.push({
          callId: groupCallId,
          message:
            String(error.message || "Call finalization failed").slice(0, 250),
        });
      }
    }
  }

  // Do not close the room if a call failed to complete.

  if (finalizationFailures.length > 0) {
    const error = httpError(
      503,
      "Some customer sessions could not be finalized. The group room has not been closed."
    );

    error.details = {
      finalizationFailures,
      billingFailures,
    };

    throw error;
  }

  /*
   * If billing is pending, do not report the group as
   * fully finalized. Calls have ended, but billing still
   * needs retry/reconciliation.
   */
  if (billingFailures.length > 0) {
    const error = httpError(
      503,
      "The calls have ended, but some billing operations are pending."
    );

    error.details = {
      billingFailures,
    };

    throw error;
  }

  // Close room and release host reservation.

  await db.runTransaction(async (transaction) => {
    const hostRef = hosts.doc(call.hostId);

    const [
      latestRoomSnapshot,
      hostSnapshot,
    ] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(hostRef),
    ]);

    if (latestRoomSnapshot.exists) {
      const latestRoom = latestRoomSnapshot.data();

      if (
        latestRoom.hostId !== call.hostId
      ) {
        throw httpError(
          403,
          "Group room ownership changed."
        );
      }

      transaction.update(roomRef, {
        status: "ended",
        endedAt: latestRoom.endedAt || new Date(),
        joinReservations: [],
        updatedAt: new Date(),
      });
    }

    if (
      hostSnapshot.exists &&
      hostSnapshot.data().activeGroupRoomId === groupRoomId
    ) {
      transaction.update(hostRef, {
        activeGroupRoomId: null,
        activeCallId: null,
        updatedAt: new Date(),
      });
    }
  });

  // Delete the actual LiveKit room.

  try {
    await getRoomService().deleteRoom(roomName);

    console.log(
      "[SA LIVE] LiveKit group room deleted:",
      groupRoomId
    );
  } catch (error) {
    if (!isMissingRoomError(error)) {
      console.error(
        "[SA LIVE] LiveKit room deletion failed:",
        {
          groupRoomId,
          message: error.message,
        }
      );

      throw httpError(
        503,
        "Calls have ended, but the LiveKit room could not be deleted."
      );
    }
  }

  return {
    endedCalls,
    billingFailures: [],
  };
}

// ============================================================
// POST /api/livekit/end
// ============================================================

router.post("/end", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const firebaseUid = getFirebaseUid(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
    } = await getAuthorizedCall(
      callId,
      firebaseUid
    );

    let reason =
      typeof req.body?.reason === "string"
        ? req.body.reason
        : "completed";

    if (!ALLOWED_END_REASONS.has(reason)) {
      throw httpError(
        400,
        "Invalid call end reason."
      );
    }

    if (isCustomer && reason === "host_ended") {
      reason = "user_ended";
    }

    if (isAssignedHost && reason === "user_ended") {
      reason = "host_ended";
    }

    // CUSTOMER ENDS ONLY THEIR OWN SESSION.

    if (isCustomer) {
      const result = await endCustomerSession(
        callId,
        call,
        firebaseUid,
        reason
      );

      noCacheResponse(res);

      return res.status(200).json({
        success: true,
        message: "Your call has ended.",
        call: result,
      });
    }

    // HOST ENDS THE SHARED GROUP ROOM.

    if (
      isAssignedHost &&
      call.groupRoomId
    ) {
      const result = await endHostGroupSession(
        call,
        callId,
        reason === "completed"
          ? "host_ended"
          : reason
      );

      noCacheResponse(res);

      return res.status(200).json({
        success: true,
        message: "The group call has ended.",
        endedCallCount: result.endedCalls.length,
        billingFailures: result.billingFailures,
        call:
          result.endedCalls.find(
            (item) => item?.id === callId
          ) || null,
      });
    }

    // LEGACY ONE-TO-ONE HOST SESSION.

    const result = await endCall(
      callId,
      reason
    );

    noCacheResponse(res);

    return res.status(200).json({
      success: true,
      message: "Call ended.",
      call: result,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;