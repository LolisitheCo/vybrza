
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
  removeCallFromGroupRoom,
} from "../services/groupRoomService.js";

const router = express.Router();

router.use(verifyFirebaseToken);

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

const MAX_GROUP_PARTICIPANTS = 6;
const JOIN_RESERVATION_MS = 120_000;
const TOKEN_TTL = "90s";

const VALID_CALL_ID = /^[A-Za-z0-9_-]{1,150}$/;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateCallId(value) {
  if (
    typeof value !== "string" ||
    !VALID_CALL_ID.test(value.trim())
  ) {
    throw httpError(400, "A valid callId is required.");
  }

  return value.trim();
}

function getCallId(req) {
  return validateCallId(req.body?.callId);
}

function getLiveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

  if (!url || !apiKey || !apiSecret) {
    throw new Error("LiveKit server configuration is missing.");
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
  const { url, apiKey, apiSecret } = getLiveKitConfig();
  const parsedUrl = new URL(url);

  // RoomServiceClient uses the HTTP(S) API endpoint.
  if (parsedUrl.protocol === "wss:") {
    parsedUrl.protocol = "https:";
  }

  return new RoomServiceClient(
    parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret
  );
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];

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
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("room_not_found")
  );
}

async function getRoomParticipants(roomName) {
  try {
    return await getRoomService().listParticipants(roomName);
  } catch (error) {
    if (isMissingRoomError(error)) {
      return [];
    }

    throw error;
  }
}

async function getAuthorizedCall(callId, firebaseUid) {
  const snapshot = await callSessions.doc(callId).get();

  if (!snapshot.exists) {
    throw httpError(404, "Call session not found.");
  }

  const call = {
    id: snapshot.id,
    ...snapshot.data(),
  };

  const isCustomer = call.userId === firebaseUid;

  let isAssignedHost = false;
  let hostData = null;

  if (
    typeof call.hostId === "string" &&
    call.hostId
  ) {
    const hostSnapshot = await hosts.doc(call.hostId).get();

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

/*
|--------------------------------------------------------------------------
| GROUP ROOM AUTHORIZATION
|--------------------------------------------------------------------------
*/


async function verifyGroupRoomMembership({
  callId,
  call,
  firebaseUid,
  isCustomer,
  isAssignedHost,
  hostData,
}) {
  const result = await getGroupRoomForCall(callId);

  // getGroupRoomForCall returns { callId, call, room }.
  // The actual room document is inside result.room.
  const room = result?.room;

  if (
    !result ||
    result.callId !== callId ||
    !room ||
    room.id !== call.groupRoomId ||
    !room.roomName ||
    (call.roomId && call.roomId !== room.roomName) ||
    room.status === "ended" ||
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

  if (isCustomer && !customerIds.includes(firebaseUid)) {
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


/*
|--------------------------------------------------------------------------
| TEMPORARY GROUP ROOM JOIN RESERVATION
|--------------------------------------------------------------------------
|
| A LiveKit token request reserves a participant slot in Firestore.
| The reservation expires automatically after a short period.
|
| Live participants and active reservations are counted together.
| This prevents concurrent token requests from exceeding the
| one-host-plus-three-customers limit.
|
| Reservations are stored on callRooms documents as:
| joinReservations: [
|   { identity: "...", expiresAt: Date }
| ]
|--------------------------------------------------------------------------
*/

async function reserveGroupRoomSlot({
  groupRoomId,
  roomName,
  identity,
  expectedCustomerIds,
  isHost,
}) {
  const roomRef = callRooms.doc(groupRoomId);

  // Fetch LiveKit participants before the Firestore transaction.
  const liveParticipants = await getRoomParticipants(roomName);

  const liveIdentities = new Set(
    liveParticipants
      .map((participant) => participant.identity)
      .filter((value) => typeof value === "string")
  );

  return db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);

    if (!roomSnapshot.exists) {
      throw httpError(404, "Group room not found.");
    }

    const room = roomSnapshot.data();

    if (
      room.roomName !== roomName ||
      room.status === "ended" ||
      room.endedAt
    ) {
      throw httpError(
        409,
        "This group room is no longer available."
      );
    }

    const customerIds = normalizeIds(room.customerIds);

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
      Array.isArray(expectedCustomerIds) &&
      expectedCustomerIds.some(
        (customerId) => !customerIds.includes(customerId)
      )
    ) {
      throw httpError(
        409,
        "Group room membership has changed. Request a new token."
      );
    }

    const now = Date.now();

    const existingReservations = Array.isArray(
      room.joinReservations
    )
      ? room.joinReservations
      : [];

    const activeReservations = existingReservations.filter(
      (reservation) => {
        if (
          !reservation ||
          typeof reservation.identity !== "string"
        ) {
          return false;
        }

        return toMillis(reservation.expiresAt) > now;
      }
    );

    const occupiedIdentities = new Set(liveIdentities);

    for (const reservation of activeReservations) {
      occupiedIdentities.add(reservation.identity);
    }

    /*
     * A participant already present in the room does not consume
     * a second slot when requesting another token.
     */
    const alreadyCounted = occupiedIdentities.has(identity);

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

    const nextReservations = activeReservations.filter(
      (reservation) => reservation.identity !== identity
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
      participantCount: occupiedIdentities.size,
    };
  });
}

/*
|--------------------------------------------------------------------------
| POST /api/livekit/token
|--------------------------------------------------------------------------
|
| Body: { "callId": "..." }
|
| Customer: token for their own call session.
| Host: token for a call assigned to them.
|--------------------------------------------------------------------------
*/

router.post("/token", async (req, res, next) => {
  try {
    const callId = getCallId(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
      hostData,
    } = await getAuthorizedCall(callId, req.user.uid);

    if (!["matched", "active"].includes(call.status)) {
      throw httpError(
        409,
        "This call is not ready to join."
      );
    }

    const { url, apiKey, apiSecret } = getLiveKitConfig();
let roomName = getRoomName(call);

if (call.groupRoomId) {
  const groupRoom = await verifyGroupRoomMembership({
    callId,
    call,
    firebaseUid: req.user.uid,
    isCustomer,
    isAssignedHost,
    hostData,
  });

  roomName = groupRoom.roomName;

      await reserveGroupRoomSlot({
        groupRoomId: call.groupRoomId,
        roomName,
        identity: req.user.uid,
        isHost: isAssignedHost,
      });
    } else {
      // Legacy one-to-one sessions still receive a room token,
      // but must not exceed their two expected participants.
      const participants = await getRoomParticipants(roomName);

      const alreadyInRoom = participants.some(
        (participant) =>
          participant.identity === req.user.uid
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

    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.user.uid,
      ttl: TOKEN_TTL,
      metadata: JSON.stringify({
        callId,
        role: isCustomer ? "customer" : "host",
        groupRoomId: call.groupRoomId || null,
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

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

/*
|--------------------------------------------------------------------------
| POST /api/livekit/start
|--------------------------------------------------------------------------
|
| Starts this customer's timer only when both the customer and
| assigned host are present in the shared LiveKit room.
|--------------------------------------------------------------------------
*/


router.post("/start", async (req, res, next) => {
  try {
    const callId = getCallId(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
      hostData,
    } = await getAuthorizedCall(callId, req.user.uid);

    if (!["matched", "active"].includes(call.status)) {
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

// Verify the customer and host still belong to this room.
if (call.groupRoomId) {
  const groupRoom = await verifyGroupRoomMembership({
    callId,
    call,
    firebaseUid: req.user.uid,
    isCustomer,
    isAssignedHost,
    hostData,
  });

  roomName = groupRoom.roomName;
}

    // Confirm actual LiveKit presence before starting or
    // confirming an already-active customer session.
    const participants = await getRoomParticipants(roomName);

    const identities = new Set(
      participants
        .map((participant) => participant.identity)
        .filter((identity) => typeof identity === "string")
    );

    if (
      !identities.has(call.userId) ||
      !identities.has(hostData.firebaseUid)
    ) {
      throw httpError(
        409,
        "Both this customer and the assigned host must be present in the room."
      );
    }

    const { url } = getLiveKitConfig();

    /*
     * startCall handles both cases:
     * - matched: starts this customer's individual timer;
     * - active: returns the existing session without resetting
     *   its start time or minutesAtStart.
     */
    const startedCall = await startCall(
      callId,
      roomName,
      url
    );

    // Mark the shared room active after the individual
    // customer session has successfully started.
    if (call.groupRoomId) {
      const roomRef = callRooms.doc(call.groupRoomId);

      await db.runTransaction(async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef);

        if (!roomSnapshot.exists) {
          throw httpError(
            409,
            "The group room record was not found."
          );
        }

        const roomData = roomSnapshot.data();

        if (
          roomData.status === "ended" ||
          roomData.endedAt
        ) {
          throw httpError(
            409,
            "This group room has already ended."
          );
        }

        transaction.update(roomRef, {
          status: "active",
          startedAt: roomData.startedAt || new Date(),
          updatedAt: new Date(),
        });
      });
    }

    return res.status(200).json({
      success: true,
      message:
        startedCall.status === "active"
          ? "Call is active."
          : "Call started.",
      call: startedCall,
    });
  } catch (error) {
    return next(error);
  }
});


/*
|--------------------------------------------------------------------------
| END CUSTOMER SESSION
|--------------------------------------------------------------------------
*/

async function endCustomerSession(call, callId, reason) {
  let result;
  let endError = null;

  try {
    result = await endCall(callId, reason);
  } catch (error) {
    endError = error;
  }

  /*
   * callService.endCall() performs group-room cleanup.
   * This fallback handles cases where ending the call failed
   * before the cleanup step could run.
   */
  if (call.groupRoomId) {
    try {
      const latestCallSnapshot = await callSessions
        .doc(callId)
        .get();

      const latestCall = latestCallSnapshot.exists
        ? latestCallSnapshot.data()
        : null;

      const stillInRoom = latestCall?.groupRoomId === call.groupRoomId;

      if (stillInRoom) {
        await removeCallFromGroupRoom({ callId });
      }
    } catch (cleanupError) {
      console.error(
        "SA LIVE customer group-room cleanup failed:",
        {
          callId,
          message:
            typeof cleanupError?.message === "string"
              ? cleanupError.message.slice(0, 250)
              : "Unknown cleanup error",
        }
      );

      if (!endError) {
        endError = cleanupError;
      }
    }
  }

  if (endError) {
    throw endError;
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| END HOST GROUP SESSION
|--------------------------------------------------------------------------
*/

async function endHostGroupSession(call, callId, reason) {
  const roomRef = callRooms.doc(call.groupRoomId);
  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists) {
    const result = await endCall(callId, reason);

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

  const callIds = normalizeIds(roomData.callIds);

  if (!callIds.includes(callId)) {
    callIds.push(callId);
  }

  const results = [];
  const billingFailures = [];

  /*
   * End every customer's session independently.
   * Continue even if one customer's billing fails.
   */
  for (const groupCallId of callIds) {
    const groupCallSnapshot = await callSessions
      .doc(groupCallId)
      .get();

    if (!groupCallSnapshot.exists) continue;

    const groupCall = groupCallSnapshot.data();

    if (
      groupCall.hostId !== call.hostId ||
      groupCall.groupRoomId !== call.groupRoomId
    ) {
      continue;
    }

    const shouldProcess =
      ["matching", "matched", "active"].includes(groupCall.status) ||
      (
        groupCall.status === "completed" &&
        groupCall.billingStatus !== "finalized"
      );

    if (!shouldProcess) continue;

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
   * Close the room and release the host reservation even if
   * an individual billing finalization failed.
   */
  await db.runTransaction(async (transaction) => {
    const hostRef = hosts.doc(call.hostId);

    // All reads must happen before any writes.
    const [latestRoomSnapshot, hostSnapshot] =
      await Promise.all([
        transaction.get(roomRef),
        transaction.get(hostRef),
      ]);

    if (latestRoomSnapshot.exists) {
      transaction.update(roomRef, {
        status: "ended",
        endedAt:
          latestRoomSnapshot.data().endedAt || new Date(),
        updatedAt: new Date(),
      });
    }

    if (
      hostSnapshot.exists &&
      hostSnapshot.data()?.activeGroupRoomId === call.groupRoomId
    ) {
      transaction.update(hostRef, {
        activeGroupRoomId: null,
        updatedAt: new Date(),
      });
    }
  });

  /*
   * Delete the LiveKit room after the database has been marked
   * ended. This prevents new tokens from being issued.
   */
  try {
    await getRoomService().deleteRoom(getRoomName(call));
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

/*
|--------------------------------------------------------------------------
| POST /api/livekit/end
|--------------------------------------------------------------------------
|
| Customer: ends only their own call session.
| Host: ends every customer session in the shared group room.
|--------------------------------------------------------------------------
*/

router.post("/end", async (req, res, next) => {
  try {
    const callId = getCallId(req);

    const {
      call,
      isCustomer,
      isAssignedHost,
    } = await getAuthorizedCall(callId, req.user.uid);

    const requestedReason =
      typeof req.body?.reason === "string"
        ? req.body.reason
        : "completed";

    const allowedReasons = new Set([
      "completed",
      "user_ended",
      "host_ended",
      "connection_lost",
      "insufficient_balance",
    ]);

    if (!allowedReasons.has(requestedReason)) {
      throw httpError(400, "Invalid call end reason.");
    }

    let reason = requestedReason;

    if (isCustomer && reason === "host_ended") {
      reason = "user_ended";
    }

    if (isAssignedHost && reason === "user_ended") {
      reason = "host_ended";
    }

    if (isCustomer) {
      const result = await endCustomerSession(
        call,
        callId,
        reason
      );

      return res.status(200).json({
        success: true,
        message: "Your call has ended.",
        call: result,
      });
    }

    if (isAssignedHost && call.groupRoomId) {
      const result = await endHostGroupSession(
        call,
        callId,
        reason === "completed" ? "host_ended" : reason
      );

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

    // Legacy one-to-one host/customer call.
    const result = await endCall(callId, reason);

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
