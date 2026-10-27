
import express from "express";
import {
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";

import { db } from "../config/firebase.js";
import { startCall, endCall } from "../services/callService.js";

const router = express.Router();

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");

function getLiveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

  if (!url || !apiKey || !apiSecret) {
    throw new Error("LiveKit webhook configuration is missing.");
  }

  return { url, apiKey, apiSecret };
}

function getCallIdFromRoomName(roomName) {
  if (typeof roomName !== "string") return null;

  const match = /^salive-([A-Za-z0-9_-]{1,150})$/.exec(roomName);
  return match?.[1] ?? null;
}

/*
 * POST /api/livekit/webhook
 *
 * LiveKit sends signed events to this endpoint.
 * The raw request body is required for signature validation.
 */
router.post(
  "/webhook",
  express.raw({ type: "application/webhook+json", limit: "100kb" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({
          success: false,
          message: "Expected a raw LiveKit webhook body.",
        });
      }

      const { url, apiKey, apiSecret } = getLiveKitConfig();
      const receiver = new WebhookReceiver(apiKey, apiSecret);

      const event = await receiver.receive(
        req.body.toString("utf8"),
        req.get("Authorization")
      );

      const roomName = event.room?.name;
      const callId = getCallIdFromRoomName(roomName);

      // Ignore events for rooms that do not belong to SA LIVE.
      if (!callId) {
        return res.status(200).json({ success: true, ignored: true });
      }

      const callRef = callSessions.doc(callId);
      const callSnapshot = await callRef.get();

      // A delayed event may arrive after the call record is gone.
      if (!callSnapshot.exists) {
        return res.status(200).json({ success: true, ignored: true });
      }

      const call = callSnapshot.data();

      if (event.event === "participant_joined") {
        if (call.status !== "matched") {
          return res.status(200).json({ success: true });
        }

        const roomService = new RoomServiceClient(url, apiKey, apiSecret);
        const participants = await roomService.listParticipants(roomName);
        const identities = new Set(
          participants.map((participant) => participant.identity)
        );

        const hostSnapshot = await hosts.doc(call.hostId).get();
        const hostUid = hostSnapshot.data()?.firebaseUid;

        if (
          hostUid &&
          identities.has(call.userId) &&
          identities.has(hostUid)
        ) {
          await startCall(callId, roomName, url);
        }
      }

      if (event.event === "room_finished") {
        if (["matching", "matched", "active"].includes(call.status)) {
          await endCall(callId, "connection_lost");
        }
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      // A non-2xx response allows LiveKit to retry delivery.
      console.error("SA LIVE webhook processing failed:", {
        message: error?.message || "Unknown error",
      });

      return res.status(500).json({
        success: false,
        message: "Webhook processing failed.",
      });
    }
  }
);

export default router;
