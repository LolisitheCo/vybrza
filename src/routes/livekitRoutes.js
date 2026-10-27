
import express from "express";
import { AccessToken } from "livekit-server-sdk";

import { db } from "../config/firebase.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

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

/*
 * POST /api/livekit/token
 *
 * Body:
 * { "callId": "your-call-session-id" }
 *
 * Only the customer or the assigned host can obtain a room token.
 * This endpoint does not start the call timer or finalize billing.
 */
router.post("/token", async (req, res, next) => {
  try {
    const callId =
      typeof req.body?.callId === "string"
        ? req.body.callId.trim()
        : "";

    if (!callId || callId.length > 200) {
      return res.status(400).json({
        success: false,
        message: "A valid callId is required.",
      });
    }

    const callRef = callSessions.doc(callId);
    const callSnapshot = await callRef.get();

    if (!callSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: "Call session not found.",
      });
    }

    const call = callSnapshot.data();
    const firebaseUid = req.user.uid;

    const isCustomer = call.userId === firebaseUid;

    let isAssignedHost = false;

    if (typeof call.hostId === "string" && call.hostId) {
      const hostSnapshot = await hosts
        .doc(call.hostId)
        .get();

      isAssignedHost =
        hostSnapshot.exists &&
        hostSnapshot.data()?.firebaseUid === firebaseUid &&
        hostSnapshot.data()?.status === "active";
    }

    if (!isCustomer && !isAssignedHost) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this call.",
      });
    }

    if (!["matched", "active"].includes(call.status)) {
      return res.status(409).json({
        success: false,
        message: "This call is not ready to join.",
      });
    }

    const { url, apiKey, apiSecret } = getLiveKitConfig();

    // Both participants receive tokens for the same room.
    const roomName = `salive-${callSnapshot.id}`;

    // Use a stable identity for each authenticated participant.
    const identity = firebaseUid;

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "10m",
      metadata: JSON.stringify({
        callId: callSnapshot.id,
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

    const jwt = await token.toJwt();

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      serverUrl: url,
      roomName,
      token: jwt,
      callId: callSnapshot.id,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
