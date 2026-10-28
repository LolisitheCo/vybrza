
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

const router = express.Router();

router.use(verifyFirebaseToken);

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

const MAX_GROUP_PARTICIPANTS = 4;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
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

  if (!["https:", "wss:"].includes(parsedUrl.protocol)) {
    throw new Error("LIVEKIT_URL must use HTTPS or WSS.");
  }

  return { url, apiKey, apiSecret };
}

function getCallId(req) {
  const callId =
    typeof req.body?.callId === "string"
      ? req.body.callId.trim()
      : "";

  if (!callId || callId.length > 150) {
    throw httpError(400, "A valid callId is required.");
  }

  return callId;
}

function getRoomName(call) {
  // Group-room sessions share the same LiveKit room.
  // Legacy sessions retain their original room naming.
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

  // LiveKit's room-management API uses HTTP(S), not WS(S).
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol === "wss:") {
    parsedUrl.protocol = "https:";
  } else if (parsedUrl.protocol === "ws:") {
    parsedUrl.protocol = "http:";
  }

  return new RoomServiceClient(
    parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret
  );
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

  if (typeof call.hostId === "string" && call.hostId) {
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

async function getRoomParticipants(roomName) {
  const roomService = getRoomService();

  try {
    return await roomService.listParticipants(roomName);
  } catch (error) {
    // A room that does not exist yet has no participants.
    const message = String(error?.message || "").toLowerCase();

    if (
      message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("room_not_found")
    ) {
      return [];
    }

    throw error;
  }
}

/*
 * POST /api/livekit/token
 *
 * Body: { "callId": "..." }
 *
 * A customer receives a token only for their own call session.
 * The assigned host may use any one of their matched sessions
 * to join the shared group room.
 */
router.post("/token", async (req, res, next) => {
  try {
    const callId = getCallId(req);

    const {
      call,
      isCustomer,
      hostData,
    } = await getAuthorizedCall(callId, req.user.uid);

    if (!["matched", "active"].includes(call.status)) {
      return res.status(409).json({
        success: false,
        message: "This call is not ready to join.",
      });
    }

    const { url, apiKey, apiSecret } = getLiveKitConfig();
    const roomName = getRoomName(call);

    // For group rooms, verify that the group record still exists
    // and that the session belongs to that group.
    if (call.groupRoomId) {
      const groupRoom = await getGroupRoomForCall(callId);

      if (
        !groupRoom ||
        groupRoom.id !== call.groupRoomId ||
        groupRoom.roomName !== roomName ||
        groupRoom.status === "ended" ||
        groupRoom.endedAt
      ) {
        return res.status(409).json({
          success: false,
          message: "This group room is no longer available.",
        });
      }
    }

    const participants = await getRoomParticipants(roomName);

    const alreadyInRoom = participants.some(
      (participant) => participant.identity === req.user.uid
    );

    // The shared room is limited to one host and three customers.
    // This check is best-effort; the frontend must not treat it
    // as a substitute for server-side room/session authorization.
    if (
      !alreadyInRoom &&
      participants.length >= MAX_GROUP_PARTICIPANTS
    ) {
      return res.status(409).json({
        success: false,
        message: "This call room is full. Please try again shortly.",
      });
    }

    // Ensure the assigned host account is still valid.
    if (!isCustomer && !hostData?.firebaseUid) {
      return res.status(403).json({
        success: false,
        message: "The assigned host account is unavailable.",
      });
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.user.uid,
      ttl: "10m",
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
 * POST /api/livekit/start
 *
 * Body: { "callId": "..." }
 *
 * Starts this customer's individual billing timer only after
 * both that customer and the assigned host are in the room.
 * Other customers in the same room retain separate sessions.
 */
router.post("/start", async (req, res, next) => {
  try {
    const callId = getCallId(req);

    const {
      call,
      hostData,
    } = await getAuthorizedCall(callId, req.user.uid);

    if (call.status === "active") {
      return res.status(200).json({
        success: true,
        message: "Call is already active.",
        call,
      });
    }

    if (call.status !== "matched") {
      return res.status(409).json({
        success: false,
        message: "Only a matched call can be started.",
      });
    }

    if (!hostData?.firebaseUid) {
      return res.status(409).json({
        success: false,
        message: "The assigned host is unavailable.",
      });
    }

    const roomName = getRoomName(call);
    const participants = await getRoomParticipants(roomName);

    const identities = new Set(
      participants.map((participant) => participant.identity)
    );

    if (
      !identities.has(call.userId) ||
      !identities.has(hostData.firebaseUid)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Both this customer and the assigned host must join the room before the timer starts.",
      });
    }

    const { url } = getLiveKitConfig();

    const startedCall = await startCall(
      callId,
      roomName,
      url
    );

    // Mark the shared room active, without changing other
    // customers' individual call sessions.
    if (call.groupRoomId) {
      const roomRef = callRooms.doc(call.groupRoomId);

      await db.runTransaction(async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef);

        if (!roomSnapshot.exists) {
          throw httpError(409, "The group room record was not found.");
        }

        const roomData = roomSnapshot.data();

        if (roomData.status === "ended" || roomData.endedAt) {
          throw httpError(409, "This group room has already ended.");
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
      message: "Call started.",
      call: startedCall,
    });
  } catch (error) {
    return next(error);
  }
});

/*
 * POST /api/livekit/end
 *
 * Body: { "callId": "...", "reason": "user_ended" }
 *
 * Customer: ends only their own session.
 * Host: ends all active/matched sessions in their group room.
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
      return res.status(400).json({
        success: false,
        message: "Invalid call end reason.",
      });
    }

    // Customers cannot claim that the host ended their call.
    // Hosts cannot claim that the customer ended the call.
    let reason = requestedReason;

    if (isCustomer && requestedReason === "host_ended") {
      reason = "user_ended";
    } else if (isAssignedHost && requestedReason === "user_ended") {
      reason = "host_ended";
    }

    // A customer leaving must not end the shared room or another
    // customer's session.
    if (isCustomer) {
      const result = await endCall(callId, reason);

      if (call.groupRoomId) {
        const roomRef = callRooms.doc(call.groupRoomId);

        await db.runTransaction(async (transaction) => {
          const roomSnapshot = await transaction.get(roomRef);

          if (!roomSnapshot.exists) return;

          const roomData = roomSnapshot.data();
          const customerIds = Array.isArray(roomData.customerIds)
            ? roomData.customerIds
            : [];

          transaction.update(roomRef, {
            customerIds: customerIds.filter(
              (customerId) => customerId !== call.userId
            ),
            updatedAt: new Date(),
          });
        });
      }

      return res.status(200).json({
        success: true,
        message: "Your call has ended.",
        call: result,
      });
    }

    // When the host ends the shared session, end each associated
    // customer session individually. This is intentionally
    // different from a customer leaving.
    if (isAssignedHost && call.groupRoomId) {
      const roomRef = callRooms.doc(call.groupRoomId);
      const roomSnapshot = await roomRef.get();

      if (!roomSnapshot.exists) {
        const result = await endCall(callId, reason);

        return res.status(200).json({
          success: true,
          message: "Call ended.",
          call: result,
        });
      }

      const roomData = roomSnapshot.data();

      if (roomData.hostId !== call.hostId) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this group room.",
        });
      }

      const callIds = Array.isArray(roomData.callIds)
        ? [...new Set(roomData.callIds)]
        : [callId];

      const results = [];

      for (const groupCallId of callIds) {
        const groupCallSnapshot = await callSessions
          .doc(groupCallId)
          .get();

        if (!groupCallSnapshot.exists) continue;

        const groupCall = groupCallSnapshot.data();

        if (
          groupCall.hostId !== call.hostId ||
          groupCall.groupRoomId !== call.groupRoomId ||
          !["matched", "active"].includes(groupCall.status)
        ) {
          continue;
        }

        const ended = await endCall(
          groupCallId,
          reason === "completed" ? "host_ended" : reason
        );

        results.push(ended);
      }

      await db.runTransaction(async (transaction) => {
        const latestRoom = await transaction.get(roomRef);

        if (!latestRoom.exists) return;

        transaction.update(roomRef, {
          status: "ended",
          endedAt: new Date(),
          updatedAt: new Date(),
        });

        const hostRef = hosts.doc(call.hostId);
        const hostSnapshot = await transaction.get(hostRef);

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

      // End the LiveKit room as well so nobody can remain connected
      // after the host has ended the shared session.
      try {
        await getRoomService().deleteRoom(getRoomName(call));
      } catch (error) {
        const message = String(error?.message || "").toLowerCase();

        if (
          !message.includes("not found") &&
          !message.includes("does not exist") &&
          !message.includes("room_not_found")
        ) {
          throw error;
        }
      }

      return res.status(200).json({
        success: true,
        message: "The group call has ended.",
        endedCallCount: results.length,
        call: results.find((item) => item?.id === callId) || null,
      });
    }

    // Legacy one-to-one call.
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
