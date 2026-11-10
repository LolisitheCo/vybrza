
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
// Group calls: 1 host + up to 5 customers
// Maximum participants: 6
// ============================================================

const router = express.Router();

router.use(verifyFirebaseToken);

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

const MAX_GROUP_PARTICIPANTS = 6;
const JOIN_RESERVATION_MS = 120_000;
const TOKEN_TTL = "90s";

const VALID_CALL_ID = /^[A-Za-z0-9_-]{1,150}$/;

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
]);

// ============================================================
// ERROR HELPERS
// ============================================================

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function validateCallId(value) {
  if (
    typeof value !== "string" ||
    !VALID_CALL_ID.test(value.trim())
  ) {
    throw httpError(
      400,
      "A valid callId is required."
    );
  }

  return value.trim();
}

function getCallId(req) {
  return validateCallId(req.body?.callId);
}

function getFirebaseUid(req) {
  const uid = req.user?.uid;

  if (
    typeof uid !== "string" ||
    !uid.trim()
  ) {
    throw httpError(
      401,
      "Authentication is required."
    );
  }

  return uid.trim();
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
      "LIVEKIT_URL must be a valid secure LiveKit URL."
    );
  }

  return {
    url: parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret,
  };
}

function getRoomName(call) {
  if (
    typeof call.roomId === "string" &&
    call.roomId.trim()
  ) {
    return call.roomId.trim();
  }

  return `salive-${call.id}`;
}

function getRoomService() {
  const {
    url,
    apiKey,
    apiSecret,
  } = getLiveKitConfig();

  const parsedUrl = new URL(url);

  if (parsedUrl.protocol === "wss:") {
    parsedUrl.protocol = "https:";
  }

  return new RoomServiceClient(
    parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret
  );
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function normalizeIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter(
        (item) =>
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= 150
      )
    ),
  ];
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

function noStore(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
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

  // Support both current and legacy customer records.
  const isCustomer =
    call.userId === firebaseUid ||
    call.customerUid === firebaseUid;

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
        hostData?.firebaseUid === firebaseUid &&
        hostData?.status === "active";
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
    (
      call.roomId &&
      call.roomId !== room.roomName
    ) ||
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

  const customerIds = normalizeIds(room.customerIds);
  const callIds = normalizeIds(room.callIds);

  if (!callIds.includes(callId)) {
    throw httpError(
      403,
      "This call is not assigned to the group room."
    );
  }

  if (
    isCustomer &&
    !customerIds.includes(firebaseUid)
  ) {
    throw httpError(
      403,
      "You are not a member of this group room."
    );
  }

  if (
    isAssignedHost &&
    (
      !hostData?.firebaseUid ||
      hostData.firebaseUid !== firebaseUid
    )
  ) {
    throw httpError(
      403,
      "You are not authorized to join this host room."
    );
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
  isHost,
}) {
  const roomRef = callRooms.doc(groupRoomId);

  // Read LiveKit presence before starting the Firestore transaction.
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
    const roomSnapshot = await transaction.get(
      roomRef
    );

    if (!roomSnapshot.exists) {
      throw httpError(
        404,
        "Group room not found."
      );
    }

    const room = roomSnapshot.data();

    if (
      room.roomName !== roomName ||
      !["waiting_host", "active"].includes(room.status) ||
      room.endedAt
    ) {
      throw httpError(
        409,
        "This group room is no longer available."
      );
    }

    const customerIds = normalizeIds(
      room.customerIds
    );

    const callIds = normalizeIds(
      room.callIds
    );

    if (!callIds.includes(callId)) {
      throw httpError(
        403,
        "This call is not registered in this group room."
      );
    }

    if (
      !isHost &&
      !customerIds.includes(identity)
    ) {
      throw httpError(
        403,
        "You are not registered in this group room."
      );
    }

    if (
      isHost &&
      room.hostId === undefined
    ) {
      throw httpError(
        403,
        "This group room has no assigned host."
      );
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
          if (
            !reservation ||
            typeof reservation.identity !== "string"
          ) {
            return false;
          }

          return (
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
        "This call room is full. Please try again shortly."
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
      expiresAt,
    });

    transaction.update(roomRef, {
      joinReservations: nextReservations,
      updatedAt: new Date(),
    });

    return {
      reserved: true,
      expiresAt,
      participantCount: occupiedIdentities.size +
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
      const groupRoom =
        await verifyGroupRoomMembership({
          callId,
          call,
          firebaseUid,
          isCustomer,
          isAssignedHost,
          hostData,
        });

      roomName = groupRoom.roomName;

      await reserveGroupRoomSlot({
        groupRoomId: call.groupRoomId,
        roomName,
        identity: firebaseUid,
        callId,
        isHost: isAssignedHost,
      });
    } else {
      // Legacy one-to-one room capacity.
      const participants =
        await getRoomParticipants(roomName);

      const alreadyInRoom = participants.some(
        (participant) =>
          participant.identity === firebaseUid
      );

      if (
        !alreadyInRoom &&
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

    noStore(res);

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
      const groupRoom =
        await verifyGroupRoomMembership({
          callId,
          call,
          firebaseUid,
          isCustomer,
          isAssignedHost,
          hostData,
        });

      roomName = groupRoom.roomName;
    }

    // Confirm actual LiveKit presence.
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
        "Both this customer and the assigned host must be present in the room."
      );
    }

    const { url } = getLiveKitConfig();

    /*
     * callService.startCall is responsible for:
     * - starting the customer's timer;
     * - checking balance;
     * - checking room membership;
     * - marking the group room active.
     *
     * Do not update the group room again here.
     */
    const startedCall = await startCall(
      callId,
      roomName,
      url
    );

    noStore(res);

    return res.status(200).json({
      success: true,
      message: "Call is active.",
      call: startedCall,
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
  reason
) {
  /*
   * callService.endCall handles:
   * - marking the session completed;
   * - releasing the customer's reservation;
   * - removing the call from its group room;
   * - finalizing billing.
   *
   * Do not independently remove group membership here.
   * If billing fails after the call has ended, the callService
   * can retry billing without corrupting group membership.
   */
  return endCall(callId, reason);
}

// ============================================================
// END HOST GROUP SESSION
// ============================================================

async function endHostGroupSession(
  call,
  callId,
  reason
) {
  const roomRef = callRooms.doc(
    call.groupRoomId
  );

  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists) {
    const result = await endCall(
      callId,
      reason
    );

    return {
      endedCalls: [result],
      billingFailures: [],
    };
  }

  const roomData = roomSnapshot.data();

  if (roomData.hostId !== call.hostId) {
    throw httpError(
      403,
      "You are not assigned to this group room."
    );
  }

  const roomName = roomData.roomName;

  if (
    typeof roomName !== "string" ||
    !roomName.trim()
  ) {
    throw httpError(
      409,
      "The group room has no valid LiveKit room name."
    );
  }

  const callIds = normalizeIds(
    roomData.callIds
  );

  if (!callIds.includes(callId)) {
    callIds.push(callId);
  }

  const results = [];
  const billingFailures = [];

  /*
   * End every customer session independently.
   * Continue if one session has a billing error.
   */
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
      groupCall.groupRoomId !== call.groupRoomId
    ) {
      continue;
    }

    const shouldProcess =
      ["matching", "matched", "active"].includes(
        groupCall.status
      ) ||
      (
        groupCall.status === "completed" &&
        groupCall.billingStatus !== "finalized"
      );

    if (!shouldProcess) {
      continue;
    }

    try {
      const ended = await endCall(
        groupCallId,
        reason
      );

      results.push(ended);
    } catch (error) {
      billingFailures.push({
        callId: groupCallId,
        message:
          typeof error?.message === "string"
            ? error.message.slice(0, 250)
            : "Call finalization failed.",
      });
    }
  }

  /*
   * Close the shared room and release the host reservation.
   */
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
      transaction.update(roomRef, {
        status: "ended",
        endedAt:
          latestRoomSnapshot.data().endedAt ||
          new Date(),
        updatedAt: new Date(),
      });
    }

    if (
      hostSnapshot.exists &&
      hostSnapshot.data()?.activeGroupRoomId ===
        call.groupRoomId
    ) {
      transaction.update(hostRef, {
        activeGroupRoomId: null,
        updatedAt: new Date(),
      });
    }
  });

  /*
   * Delete the actual LiveKit room.
   * The room document is the authoritative source for roomName.
   */
  try {
    await getRoomService().deleteRoom(roomName);
  } catch (error) {
    if (!isMissingRoomError(error)) {
      console.error(
        "Could not delete ended SA LIVE LiveKit room.",
        {
          groupRoomId: call.groupRoomId,
          message:
            typeof error?.message === "string"
              ? error.message.slice(0, 250)
              : "Unknown LiveKit error",
        }
      );
    }
  }

  return {
    endedCalls: results,
    billingFailures,
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

    const requestedReason =
      typeof req.body?.reason === "string"
        ? req.body.reason
        : "completed";

    if (!ALLOWED_END_REASONS.has(requestedReason)) {
      throw httpError(
        400,
        "Invalid call end reason."
      );
    }

    let reason = requestedReason;

    if (
      isCustomer &&
      reason === "host_ended"
    ) {
      reason = "user_ended";
    }

    if (
      isAssignedHost &&
      reason === "user_ended"
    ) {
      reason = "host_ended";
    }

    // --------------------------------------------------------
    // CUSTOMER ENDS ONLY THEIR OWN SESSION
    // --------------------------------------------------------

    if (isCustomer) {
      const result = await endCustomerSession(
        callId,
        reason
      );

      noStore(res);

      return res.status(200).json({
        success: true,
        message: "Your call has ended.",
        call: result,
      });
    }

    // --------------------------------------------------------
    // HOST ENDS THE SHARED GROUP ROOM
    // --------------------------------------------------------

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

      noStore(res);

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

    // --------------------------------------------------------
    // LEGACY ONE-TO-ONE HOST SESSION
    // --------------------------------------------------------

    const result = await endCall(
      callId,
      reason
    );

    noStore(res);

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
