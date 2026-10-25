
import { db } from "../config/firebase.js";
import { finalizeCallBilling } from "./billingService.js";

const callsCollection = db.collection("callSessions");

const ALLOWED_END_REASONS = new Set([
  "completed",
  "user_ended",
  "host_ended",
  "insufficient_balance",
  "connection_lost",
  "admin_ended",
  "system_error",
]);

const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function validateId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 150 ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw new Error(`A valid ${fieldName} is required.`);
  }

  return value.trim();
}

function toCall(doc) {
  if (!doc?.exists) return null;

  return {
    id: doc.id,
    ...doc.data(),
  };
}

function toDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function sortNewestFirst(calls) {
  return calls.sort((a, b) => {
    const aTime = toDate(a.createdAt)?.getTime() || 0;
    const bTime = toDate(b.createdAt)?.getTime() || 0;

    return bTime - aTime;
  });
}

/*
|--------------------------------------------------------------------------
| CREATE CALL SESSION
|--------------------------------------------------------------------------
| Creates a pending call request.
| The host must be assigned by trusted backend code, never by trusting
| a host ID supplied directly by an unauthenticated client.
|--------------------------------------------------------------------------
*/

export async function createCallSession({ userId, hostId }) {
  const normalizedUserId = validateId(userId, "user ID");
  const normalizedHostId = validateId(hostId, "host ID");

  if (normalizedUserId === normalizedHostId) {
    throw new Error("A user cannot call their own host account.");
  }

  const now = new Date();
  const callRef = callsCollection.doc();

  const callData = {
    userId: normalizedUserId,
    hostId: normalizedHostId,

    status: "matching",

    // LiveKit room data is populated by trusted backend code.
    roomId: null,
    roomUrl: null,

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

    hostPayoutStatus: "pending",

    createdAt: now,
    updatedAt: now,
  };

  await callRef.create(callData);

  return {
    id: callRef.id,
    ...callData,
  };
}

/*
|--------------------------------------------------------------------------
| GET CALL BY ID
|--------------------------------------------------------------------------
*/

export async function getCallById(callId) {
  const normalizedCallId = validateId(callId, "call ID");

  const snapshot = await callsCollection
    .doc(normalizedCallId)
    .get();

  return toCall(snapshot);
}

/*
|--------------------------------------------------------------------------
| START CALL
|--------------------------------------------------------------------------
| Only a matched call can start.
| Call this from trusted backend code after verifying both participants
| and ensuring the LiveKit room is ready.
|--------------------------------------------------------------------------
*/

export async function startCall(callId, roomId, roomUrl) {
  const normalizedCallId = validateId(callId, "call ID");

  if (
    typeof roomId !== "string" ||
    !roomId.trim() ||
    roomId.trim().length > 256
  ) {
    throw new Error("A valid LiveKit room ID is required.");
  }

  if (
    typeof roomUrl !== "string" ||
    !/^https:\/\/[^\s]+$/i.test(roomUrl.trim()) ||
    roomUrl.trim().length > 2048
  ) {
    throw new Error("A valid secure LiveKit room URL is required.");
  }

  const callRef = callsCollection.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);

    if (!snapshot.exists) {
      throw new Error("Call not found.");
    }

    const call = snapshot.data();

    // Idempotency: retries for the same active room do not reset its timer.
    if (
      call.status === "active" &&
      call.roomId === roomId.trim() &&
      call.roomUrl === roomUrl.trim()
    ) {
      return {
        id: snapshot.id,
        ...call,
      };
    }

    if (call.status !== "matched") {
      throw new Error("Only a matched call can be started.");
    }

    if (call.startedAt || call.endedAt) {
      throw new Error("This call has already started or ended.");
    }

    const now = new Date();

    const update = {
      status: "active",
      roomId: roomId.trim(),
      roomUrl: roomUrl.trim(),
      startedAt: now,
      updatedAt: now,
    };

    transaction.update(callRef, update);

    return {
      id: snapshot.id,
      ...call,
      ...update,
    };
  });
}

/*
|--------------------------------------------------------------------------
| END CALL
|--------------------------------------------------------------------------
| Ending is idempotent. If the call is already completed but billing
| remains pending, the billing finalization step is retried.
|--------------------------------------------------------------------------
*/

export async function endCall(callId, reason = "completed") {
  const normalizedCallId = validateId(callId, "call ID");

  if (!ALLOWED_END_REASONS.has(reason)) {
    throw new Error("Invalid call end reason.");
  }

  const callRef = callsCollection.doc(normalizedCallId);

  const endedCall = await db.runTransaction(
    async (transaction) => {
      const snapshot = await transaction.get(callRef);

      if (!snapshot.exists) {
        throw new Error("Call not found.");
      }

      const call = snapshot.data();

      // Already completed: return it so pending billing can be retried.
      if (call.status === "completed") {
        return {
          id: snapshot.id,
          ...call,
          alreadyEnded: true,
        };
      }

      if (
        !["active", "matching", "matched"].includes(call.status)
      ) {
        throw new Error(
          "This call cannot be ended from its current state."
        );
      }

      const now = new Date();
      const startedAt = toDate(call.startedAt);

      const durationSeconds = startedAt
        ? Math.max(
            0,
            Math.floor(
              (now.getTime() - startedAt.getTime()) / 1000
            )
          )
        : 0;

      const minutesUsed = Math.ceil(durationSeconds / 60);

      const update = {
        status: "completed",
        endedAt: now,
        durationSeconds,
        minutesUsed,
        endReason: reason,
        billingStatus: "pending",
        updatedAt: now,
      };

      transaction.update(callRef, update);

      return {
        id: snapshot.id,
        ...call,
        ...update,
      };
    }
  );

  // finalizeCallBilling must itself be transactionally idempotent.
  // It must not deduct customer minutes or credit host earnings twice.
  if (endedCall.billingStatus !== "paid") {
    try {
      const billing = await finalizeCallBilling(endedCall.id);

      console.log("SA LIVE call billing finalized:", {
        callId: endedCall.id,
        billingStatus: billing?.billingStatus ?? "returned",
      });

      const latestCall = await getCallById(endedCall.id);

      return {
        ...(latestCall ?? endedCall),
        billing,
      };
    } catch (error) {
      // Preserve the completed call so a later retry can finalize billing.
      console.error("SA LIVE call billing finalization failed:", {
        callId: endedCall.id,
        message:
          typeof error?.message === "string"
            ? error.message.slice(0, 300)
            : "Unknown billing error",
      });

      throw error;
    }
  }

  return endedCall;
}

/*
|--------------------------------------------------------------------------
| GET USER CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getUserCallHistory(userId) {
  const normalizedUserId = validateId(userId, "user ID");

  const snapshot = await callsCollection
    .where("userId", "==", normalizedUserId)
    .get();

  return sortNewestFirst(
    snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
  );
}

/*
|--------------------------------------------------------------------------
| GET HOST CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getHostCallHistory(hostId) {
  const normalizedHostId = validateId(hostId, "host ID");

  const snapshot = await callsCollection
    .where("hostId", "==", normalizedHostId)
    .get();

  return sortNewestFirst(
    snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
  );
}
