
import express from "express";
import {
  AccessToken,
  RoomServiceClient,
} from "livekit-server-sdk";

import { db } from "../config/firebase.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { startCall, endCall } from "../services/callService.js";

const router = express.Router();

router.use(verifyFirebaseToken);

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");

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
    const error = new Error("A valid callId is required.");
    error.status = 400;
    throw error;
  }

  return callId;
}

async function getAuthorizedCall(callId, firebaseUid) {
  const snapshot = await callSessions.doc(callId).get();

  if (!snapshot.exists) {
    const error = new Error("Call session not found.");
    error.status = 404;
    throw error;
  }

  const call = snapshot.data();

  const isCustomer = call.userId === firebaseUid;
  let isAssignedHost = false;

  if (typeof call.hostId === "string" && call.hostId) {
    const hostSnapshot = await hosts.doc(call.hostId).get();

    isAssignedHost =
      hostSnapshot.exists &&
      hostSnapshot.data()?.firebaseUid === firebaseUid &&
      hostSnapshot.data()?.status === "active";
  }

  if (!isCustomer && !isAssignedHost) {
    const error = new Error(
      "You are not a participant in this call."
    );
    error.status = 403;
    throw error;
  }

  return {
    call,
    isCustomer,
    isAssignedHost,
    callRef: snapshot.ref,
  };
}

function getRoomService() {
  const { url, apiKey, apiSecret } = getLiveKitConfig();

  return new RoomServiceClient(url, apiKey, apiSecret);
}

/*
 * POST /api/livekit/token
 *
 * Body: { "callId": "..." }
 */
router.post("/token", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const { call, isCustomer } = await getAuthorizedCall(
      callId,
      req.user.uid
    );

    if (!["matched", "active"].includes(call.status)) {
      return res.status(409).json({
        success: false,
        message: "This call is not ready to join.",
      });
    }

    const { url, apiKey, apiSecret } = getLiveKitConfig();
    const roomName = `salive-${callId}`;

    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.user.uid,
      ttl: "10m",
      metadata: JSON.stringify({
        callId,
        role: isCustomer ? "customer" : "host",
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
 * Starts the timer only after both assigned participants are
 * present in the expected LiveKit room.
 */
router.post("/start", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const { call } = await getAuthorizedCall(
      callId,
      req.user.uid
    );

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

    const roomName = `salive-${callId}`;
    const roomService = getRoomService();

    const participants = await roomService.listParticipants(roomName);
    const identities = new Set(
      participants.map((participant) => participant.identity)
    );

    const hostSnapshot = await hosts.doc(call.hostId).get();
    const hostUid = hostSnapshot.data()?.firebaseUid;

    if (
      !hostUid ||
      !identities.has(call.userId) ||
      !identities.has(hostUid)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Both the customer and assigned host must join the call before the timer starts.",
      });
    }

    const { url } = getLiveKitConfig();

    const startedCall = await startCall(
      callId,
      roomName,
      url
    );

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
 * Only an assigned participant can end the call.
 */
router.post("/end", async (req, res, next) => {
  try {
    const callId = getCallId(req);
    const { call } = await getAuthorizedCall(
      callId,
      req.user.uid
    );

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

    // A participant cannot claim that the other participant ended it.
    const reason =
      requestedReason === "user_ended" && call.userId !== req.user.uid
        ? "host_ended"
        : requestedReason;

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
