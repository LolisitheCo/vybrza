
import express from "express";
import {
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";

import { db } from "../config/firebase.js";
import {
  startCall,
  endCall,
} from "../services/callService.js";

const router = express.Router();

const callSessions = db.collection("callSessions");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

function getLiveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

  if (!url || !apiKey || !apiSecret) {
    throw new Error("LiveKit webhook configuration is missing.");
  }

  const parsedUrl = new URL(url);

  if (!["https:", "wss:"].includes(parsedUrl.protocol)) {
    throw new Error("LIVEKIT_URL must use HTTPS or WSS.");
  }

  return { url, apiKey, apiSecret };
}

function getRoomService(url, apiKey, apiSecret) {
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

function getLegacyCallIdFromRoomName(roomName) {
  if (typeof roomName !== "string") return null;

  const match = /^salive-([A-Za-z0-9_-]{1,150})$/.exec(roomName);

  if (!match) return null;

  // A group room must never be mistaken for a legacy call ID.
  if (match[1].startsWith("group-")) return null;

  return match[1];
}

function isGroupRoomName(roomName) {
  return (
    typeof roomName === "string" &&
    /^salive-group-[A-Za-z0-9_-]{1,150}$/.test(roomName)
  );
}

function timestampNow() {
  return new Date();
}

async function getCallIdsForGroup(groupRoomId, roomData) {
  const callIds = new Set(
    Array.isArray(roomData?.callIds)
      ? roomData.callIds.filter(
          (id) => typeof id === "string" && id.length > 0
        )
      : []
  );

  // Include sessions linked to the group in case the room's
  // callIds array was not updated correctly.
  const snapshot = await callSessions
    .where("groupRoomId", "==", groupRoomId)
    .get();

  for (const document of snapshot.docs) {
    callIds.add(document.id);
  }

  return [...callIds];
}

async function startEligibleGroupCalls(roomData, roomName, url, roomService) {
  if (!roomData?.id || !roomData.hostId) return;

  if (roomData.status === "ended" || roomData.endedAt) return;

  const hostSnapshot = await hosts.doc(roomData.hostId).get();
  const hostUid = hostSnapshot.data()?.firebaseUid;

  if (!hostUid) return;

  const participants = await roomService.listParticipants(roomName);
  const identities = new Set(
    participants.map((participant) => participant.identity)
  );

  // A host must be in the room before any customer timer starts.
  if (!identities.has(hostUid)) return;

  const callIds = await getCallIdsForGroup(roomData.id, roomData);

  for (const callId of callIds) {
    const callSnapshot = await callSessions.doc(callId).get();

    if (!callSnapshot.exists) continue;

    const call = callSnapshot.data();

    if (
      call.groupRoomId !== roomData.id ||
      call.hostId !== roomData.hostId ||
      !identities.has(call.userId) ||
      call.status !== "matched"
    ) {
      continue;
    }

    // Each customer has their own call session and billing timer.
    await startCall(callId, roomName, url);
  }

  await callRooms.doc(roomData.id).update({
    status: "active",
    startedAt: roomData.startedAt || timestampNow(),
    updatedAt: timestampNow(),
  });
}

async function endUnfinishedGroupCalls(groupRoomId, roomData) {
  const callIds = await getCallIdsForGroup(groupRoomId, roomData);

  for (const callId of callIds) {
    const callSnapshot = await callSessions.doc(callId).get();

    if (!callSnapshot.exists) continue;

    const call = callSnapshot.data();

    if (
      call.groupRoomId !== groupRoomId ||
      !["matching", "matched", "active"].includes(call.status)
    ) {
      continue;
    }

    // Do not end an unrelated customer's call session.
    await endCall(callId, "connection_lost");
  }

  const roomRef = callRooms.doc(groupRoomId);

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);

    if (!roomSnapshot.exists) return;

    const latestRoom = roomSnapshot.data();

    if (latestRoom.status === "ended" && latestRoom.endedAt) {
      return;
    }

    transaction.update(roomRef, {
      status: "ended",
      endedAt: timestampNow(),
      updatedAt: timestampNow(),
    });

    const hostRef = hosts.doc(latestRoom.hostId);
    const hostSnapshot = await transaction.get(hostRef);

    if (
      hostSnapshot.exists &&
      hostSnapshot.data()?.activeGroupRoomId === groupRoomId
    ) {
      transaction.update(hostRef, {
        activeGroupRoomId: null,
        updatedAt: timestampNow(),
      });
    }
  });
}

/*
 * POST /api/livekit/webhook
 *
 * IMPORTANT:
 * Keep this route using the raw request body.
 * LiveKit validates its webhook signature using the original body.
 */
router.post(
  "/webhook",
  express.raw({
    type: "application/webhook+json",
    limit: "100kb",
  }),
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

      if (typeof roomName !== "string" || !roomName) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      /*
       * GROUP ROOM EVENTS
       */
      if (isGroupRoomName(roomName)) {
        const roomSnapshot = await callRooms
          .where("roomName", "==", roomName)
          .limit(1)
          .get();

        if (roomSnapshot.empty) {
          return res.status(200).json({
            success: true,
            ignored: true,
          });
        }

        const roomDocument = roomSnapshot.docs[0];
        const groupRoomId = roomDocument.id;
        const roomData = {
          id: roomDocument.id,
          ...roomDocument.data(),
        };

        if (
          event.event === "participant_joined" ||
          event.event === "participant_left"
        ) {
          if (
            roomData.status !== "ended" &&
            !roomData.endedAt
          ) {
            const roomService = getRoomService(
              url,
              apiKey,
              apiSecret
            );

            await startEligibleGroupCalls(
              roomData,
              roomName,
              url,
              roomService
            );
          }
        }

        if (event.event === "room_finished") {
          await endUnfinishedGroupCalls(
            groupRoomId,
            roomData
          );
        }

        return res.status(200).json({ success: true });
      }

      /*
       * LEGACY ONE-TO-ONE ROOM EVENTS
       */
      const callId = getLegacyCallIdFromRoomName(roomName);

      if (!callId) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      const callRef = callSessions.doc(callId);
      const callSnapshot = await callRef.get();

      if (!callSnapshot.exists) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      const call = callSnapshot.data();

      // A legacy room should not be used to control a group session.
      if (call.groupRoomId) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      if (event.event === "participant_joined") {
        if (call.status !== "matched") {
          return res.status(200).json({ success: true });
        }

        const roomService = getRoomService(
          url,
          apiKey,
          apiSecret
        );

        const participants = await roomService.listParticipants(
          roomName
        );

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
