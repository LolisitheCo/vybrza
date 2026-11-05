
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

const MAX_GROUP_PARTICIPANTS = 6;

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
  }

  return new RoomServiceClient(
    parsedUrl.toString().replace(/\/+$/, ""),
    apiKey,
    apiSecret
  );
}

function timestampNow() {
  return new Date();
}

function isGroupRoomName(roomName) {
  return (
    typeof roomName === "string" &&
    /^salive-group-[A-Za-z0-9_-]{1,150}$/.test(roomName)
  );
}

function getLegacyCallIdFromRoomName(roomName) {
  if (typeof roomName !== "string") {
    return null;
  }

  const match = /^salive-([A-Za-z0-9_-]{1,150})$/.exec(roomName);

  if (!match) {
    return null;
  }

  // Never interpret a group room as a legacy call.
  if (match[1].startsWith("group-")) {
    return null;
  }

  return match[1];
}

function normalizeIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values.filter(
        (value) =>
          typeof value === "string" &&
          value.trim().length > 0 &&
          value.length <= 150
      )
    ),
  ];
}

function isActiveCallStatus(status) {
  return ["matching", "matched", "active"].includes(status);
}

async function getCallIdsForGroup(groupRoomId, roomData) {
  const callIds = new Set(normalizeIds(roomData?.callIds));

  // Recover sessions even if callIds was not updated correctly.
  const snapshot = await callSessions
    .where("groupRoomId", "==", groupRoomId)
    .get();

  for (const document of snapshot.docs) {
    callIds.add(document.id);
  }

  return [...callIds];
}

async function getGroupHostIdentity(roomData) {
  if (!roomData?.hostId) {
    return null;
  }

  const hostSnapshot = await hosts.doc(roomData.hostId).get();

  if (!hostSnapshot.exists) {
    return null;
  }

  const hostUid = hostSnapshot.data()?.firebaseUid;

  return typeof hostUid === "string" && hostUid.length > 0
    ? hostUid
    : null;
}

async function getRoomIdentities(roomService, roomName) {
  const participants = await roomService.listParticipants(roomName);

  return new Set(
    participants
      .map((participant) => participant.identity)
      .filter(
        (identity) =>
          typeof identity === "string" && identity.length > 0
      )
  );
}


/**
 * Starts individual customer sessions only when:
 * - the group room is still active;
 * - the host is in the LiveKit room;
 * - the specific customer is in the LiveKit room;
 * - the customer's call is still matched.
 *
 * Each customer has their own callSession and billing timer.
 */
async function startEligibleGroupCalls(
  roomData,
  roomName,
  url,
  roomService
) {
  if (!roomData?.id || !roomData.hostId) {
    return;
  }

  if (roomData.status === "ended" || roomData.endedAt) {
    return;
  }

  const hostUid = await getGroupHostIdentity(roomData);

  if (!hostUid) {
    return;
  }

  const identities = await getRoomIdentities(
    roomService,
    roomName
  );

  // The host must be present before any customer timer starts.
  if (!identities.has(hostUid)) {
    return;
  }

  const callIds = await getCallIdsForGroup(
    roomData.id,
    roomData
  );

  let activeCustomerSessions = 0;

  for (const callId of callIds) {
    const callSnapshot = await callSessions.doc(callId).get();

    if (!callSnapshot.exists) {
      continue;
    }

    const call = callSnapshot.data();

    if (
      call.groupRoomId !== roomData.id ||
      call.hostId !== roomData.hostId ||
      !identities.has(call.userId)
    ) {
      continue;
    }

    // Count an already-active session only if it belongs
    // to this exact LiveKit room.
    if (call.status === "active") {
      if (call.roomId === roomName) {
        activeCustomerSessions += 1;
      }

      continue;
    }

    if (call.status !== "matched") {
      continue;
    }

    try {
      // startCall is transactional and idempotent.
      const startedCall = await startCall(
        callId,
        roomName,
        url
      );

      if (
        startedCall?.status === "active" &&
        startedCall.roomId === roomName
      ) {
        activeCustomerSessions += 1;
      }
    } catch (error) {
      // A customer may cancel or end their call between
      // the webhook read and the startCall transaction.
      if (error?.status === 409) {
        console.warn(
          "SA LIVE skipped a customer session that changed state.",
          { callId }
        );

        continue;
      }

      throw error;
    }
  }

  // Do not mark an empty or waiting-only room as active.
  if (activeCustomerSessions === 0) {
    return;
  }

  const roomRef = callRooms.doc(roomData.id);

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);

    if (!roomSnapshot.exists) {
      return;
    }

    const latestRoom = roomSnapshot.data();

    if (
      latestRoom.status === "ended" ||
      latestRoom.endedAt
    ) {
      return;
    }

    transaction.update(roomRef, {
      status: "active",
      startedAt: latestRoom.startedAt || timestampNow(),
      updatedAt: timestampNow(),
    });
  });
}


/**
 * Ends one customer's call without ending the shared group room.
 * callService.endCall() handles billing and room membership cleanup.
 */
async function endCustomerGroupCall(
  callId,
  groupRoomId,
  reason = "connection_lost"
) {
  const callRef = callSessions.doc(callId);
  const callSnapshot = await callRef.get();

  if (!callSnapshot.exists) {
    return;
  }

  const call = callSnapshot.data();

  if (call.groupRoomId !== groupRoomId) {
    return;
  }

  if (!isActiveCallStatus(call.status)) {
    return;
  }

  await endCall(callId, reason);
}

/**
 * Ends every unfinished customer session in a group.
 * Used when the host leaves or the room finishes.
 */
async function endUnfinishedGroupCalls(
  groupRoomId,
  roomData,
  reason = "connection_lost"
) {
  const callIds = await getCallIdsForGroup(
    groupRoomId,
    roomData
  );

  const billingFailures = [];

  for (const callId of callIds) {
    try {
      const callSnapshot = await callSessions.doc(callId).get();

      if (!callSnapshot.exists) {
        continue;
      }

      const call = callSnapshot.data();

      if (call.groupRoomId !== groupRoomId) {
        continue;
      }

      if (!isActiveCallStatus(call.status)) {
        continue;
      }

      await endCall(callId, reason);
    } catch (error) {
      billingFailures.push({
        callId,
        message: error?.message || "Unable to end call.",
      });

      console.error("SA LIVE group call ending failed:", {
        callId,
        message: error?.message || "Unknown error",
      });
    }
  }

  // Firestore transactions must complete all reads before writes.
  const roomRef = callRooms.doc(groupRoomId);

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);

    if (!roomSnapshot.exists) {
      return;
    }

    const latestRoom = roomSnapshot.data();

    const hostRef = latestRoom.hostId
      ? hosts.doc(latestRoom.hostId)
      : null;

    const hostSnapshot = hostRef
      ? await transaction.get(hostRef)
      : null;

    if (
      latestRoom.status !== "ended" ||
      !latestRoom.endedAt
    ) {
      transaction.update(roomRef, {
        status: "ended",
        endedAt: timestampNow(),
        updatedAt: timestampNow(),
        billingFailures: billingFailures.map((failure) => ({
          callId: failure.callId,
          message: failure.message.slice(0, 300),
        })),
      });
    }

    if (
      hostSnapshot?.exists &&
      hostSnapshot.data()?.activeGroupRoomId === groupRoomId
    ) {
      transaction.update(hostRef, {
        activeGroupRoomId: null,
        updatedAt: timestampNow(),
      });
    }
  });

  return billingFailures;
}

/**
 * Finds a customer session from a participant identity.
 */
async function findGroupCallForCustomer(
  groupRoomId,
  customerUid,
  roomData
) {
  const callIds = await getCallIdsForGroup(
    groupRoomId,
    roomData
  );

  for (const callId of callIds) {
    const snapshot = await callSessions.doc(callId).get();

    if (!snapshot.exists) {
      continue;
    }

    const call = snapshot.data();

    if (
      call.groupRoomId === groupRoomId &&
      call.userId === customerUid &&
      isActiveCallStatus(call.status)
    ) {
      return {
        id: callId,
        ...call,
      };
    }
  }

  return null;
}

/**
 * Handles a participant leaving a group room.
 *
 * Customer departure:
 *   Ends only that customer's call.
 *
 * Host departure:
 *   Ends all calls in the group.
 */
async function handleGroupParticipantLeft(
  event,
  groupRoomId,
  roomData,
  roomService
) {
  const participantUid = event.participant?.identity;

  if (
    typeof participantUid !== "string" ||
    !participantUid
  ) {
    return;
  }

  const hostUid = await getGroupHostIdentity(roomData);

  if (!hostUid) {
    return;
  }

  if (participantUid === hostUid) {
    await endUnfinishedGroupCalls(
      groupRoomId,
      roomData,
      "connection_lost"
    );

    // The host has left. Close the shared LiveKit room.
    try {
      await roomService.deleteRoom(roomData.roomName);
    } catch (error) {
      console.error("SA LIVE group room deletion failed:", {
        roomName: roomData.roomName,
        message: error?.message || "Unknown error",
      });
    }

    return;
  }

  const customerCall = await findGroupCallForCustomer(
    groupRoomId,
    participantUid,
    roomData
  );

  if (!customerCall) {
    return;
  }

  await endCustomerGroupCall(
    customerCall.id,
    groupRoomId,
    "connection_lost"
  );
}

/**
 * Ends legacy one-to-one calls when their room finishes.
 */
async function handleLegacyRoomFinished(callId) {
  const callSnapshot = await callSessions.doc(callId).get();

  if (!callSnapshot.exists) {
    return;
  }

  const call = callSnapshot.data();

  if (call.groupRoomId) {
    return;
  }

  if (isActiveCallStatus(call.status)) {
    await endCall(callId, "connection_lost");
  }
}

/**
 * POST /api/livekit/webhook
 *
 * This endpoint MUST receive the original raw body.
 * Do not move express.json() ahead of this route for this path.
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

      const receiver = new WebhookReceiver(
        apiKey,
        apiSecret
      );

      const event = await receiver.receive(
        req.body.toString("utf8"),
        req.get("Authorization")
      );

      const roomName = event.room?.name;

      if (
        typeof roomName !== "string" ||
        roomName.length === 0
      ) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      const roomService = getRoomService(
        url,
        apiKey,
        apiSecret
      );

      /**
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
          id: groupRoomId,
          ...roomDocument.data(),
        };

        if (
          roomData.status === "ended" ||
          roomData.endedAt
        ) {
          return res.status(200).json({
            success: true,
            ignored: true,
          });
        }

        if (event.event === "participant_joined") {
          await startEligibleGroupCalls(
            roomData,
            roomName,
            url,
            roomService
          );

          return res.status(200).json({
            success: true,
          });
        }

        if (event.event === "participant_left") {
          await handleGroupParticipantLeft(
            event,
            groupRoomId,
            roomData,
            roomService
          );

          return res.status(200).json({
            success: true,
          });
        }

        if (event.event === "room_finished") {
          const billingFailures =
            await endUnfinishedGroupCalls(
              groupRoomId,
              roomData,
              "connection_lost"
            );

          return res.status(200).json({
            success: true,
            billingFailures: billingFailures.length,
          });
        }

        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      /**
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

      // A legacy room must never control a group call.
      if (call.groupRoomId) {
        return res.status(200).json({
          success: true,
          ignored: true,
        });
      }

      if (event.event === "participant_joined") {
        if (call.status !== "matched") {
          return res.status(200).json({
            success: true,
          });
        }

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

        return res.status(200).json({
          success: true,
        });
      }

      if (event.event === "room_finished") {
        await handleLegacyRoomFinished(callId);

        return res.status(200).json({
          success: true,
        });
      }

      return res.status(200).json({
        success: true,
        ignored: true,
      });
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
