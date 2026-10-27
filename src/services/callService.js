
import { db } from "../config/firebase.js";
import { finalizeCallBilling } from "./billingService.js";

const callsCollection = db.collection("callSessions");
const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");

const ALLOWED_END_REASONS = new Set([
  "completed",
  "user_ended",
  "host_ended",
  "insufficient_balance",
  "connection_lost",
  "admin_ended",
  "system_error",
]);

const ACTIVE_STATUSES = new Set(["matching", "matched", "active"]);
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;
const MAX_ROOM_URL_LENGTH = 2048;
const MAX_ROOM_ID_LENGTH = 256;

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 150 ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw makeError(`A valid ${fieldName} is required.`, 400);
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

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value.toDate === "function") {
    const date = value.toDate();

    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date
      : null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function sortNewestFirst(calls) {
  return calls.sort((a, b) => {
    const aTime = toDate(a.createdAt)?.getTime() ?? 0;
    const bTime = toDate(b.createdAt)?.getTime() ?? 0;

    return bTime - aTime;
  });
}

function validateRoomId(roomId) {
  if (
    typeof roomId !== "string" ||
    !roomId.trim() ||
    roomId.trim().length > MAX_ROOM_ID_LENGTH
  ) {
    throw makeError("A valid LiveKit room ID is required.", 400);
  }

  return roomId.trim();
}

function validateRoomUrl(roomUrl) {
  if (
    typeof roomUrl !== "string" ||
    !roomUrl.trim() ||
    roomUrl.trim().length > MAX_ROOM_URL_LENGTH
  ) {
    throw makeError("A valid LiveKit server URL is required.", 400);
  }

  let parsed;

  try {
    parsed = new URL(roomUrl.trim());
  } catch {
    throw makeError("The LiveKit server URL is invalid.", 400);
  }

  if (
    !["https:", "wss:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw makeError("A secure LiveKit server URL is required.", 400);
  }

  return parsed.toString().replace(/\/$/, "");
}

function validateEndReason(reason) {
  if (typeof reason !== "string" || !ALLOWED_END_REASONS.has(reason)) {
    throw makeError("Invalid call end reason.", 400);
  }

  return reason;
}

/**
 * Clears a reservation only if it still belongs to this call.
 * Never clear a reservation belonging to another call.
 */
function releaseReservation(transaction, snapshot, callId, now) {
  if (!snapshot?.exists) return;

  const data = snapshot.data();

  if (data.activeCallId === callId) {
    transaction.update(snapshot.ref, {
      activeCallId: null,
      updatedAt: now,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* CREATE CALL SESSION                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Creates a call request.
 *
 * This function does not independently verify customer eligibility or host
 * availability. The trusted matching workflow must enforce eligibility and
 * reserve both records atomically.
 */
export async function createCallSession({ userId, hostId }) {
  const normalizedUserId = validateId(userId, "user ID");
  const normalizedHostId = validateId(hostId, "host ID");

  if (normalizedUserId === normalizedHostId) {
    throw makeError("A user cannot call their own host account.", 400);
  }

  const now = new Date();
  const callRef = callsCollection.doc();

  const callData = {
    userId: normalizedUserId,
    hostId: normalizedHostId,

    status: "matching",

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

    customerChargeCents: 0,
    hostEarningsCents: 0,
    saLiveRevenueCents: 0,

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

/* -------------------------------------------------------------------------- */
/* GET CALL BY ID                                                             */
/* -------------------------------------------------------------------------- */

export async function getCallById(callId) {
  const normalizedCallId = validateId(callId, "call ID");
  const snapshot = await callsCollection.doc(normalizedCallId).get();

  return toCall(snapshot);
}

/* -------------------------------------------------------------------------- */
/* START CALL                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Starts a matched call.
 *
 * IMPORTANT: Only trusted backend code should invoke this after independently
 * verifying that both assigned participants joined the expected LiveKit room.
 * This function does not itself verify participant presence.
 */
export async function startCall(callId, roomId, roomUrl) {
  const normalizedCallId = validateId(callId, "call ID");
  const normalizedRoomId = validateRoomId(roomId);
  const normalizedRoomUrl = validateRoomUrl(roomUrl);

  const callRef = callsCollection.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);

    if (!snapshot.exists) {
      throw makeError("Call not found.", 404);
    }

    const call = snapshot.data();

    // Idempotent retry: preserve the original start time.
    if (call.status === "active") {
      if (
        call.roomId === normalizedRoomId &&
        call.roomUrl === normalizedRoomUrl
      ) {
        return {
          id: snapshot.id,
          ...call,
        };
      }

      throw makeError(
        "This call is already active in a different room.",
        409
      );
    }

    if (call.status !== "matched") {
      throw makeError("Only a matched call can be started.", 409);
    }

    if (call.startedAt || call.endedAt) {
      throw makeError("This call has already started or ended.", 409);
    }

    const now = new Date();

    const update = {
      status: "active",
      roomId: normalizedRoomId,
      roomUrl: normalizedRoomUrl,
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

/* -------------------------------------------------------------------------- */
/* END CALL                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ends a call, releases its matching reservations, and attempts billing.
 *
 * The call-ending transaction and billing transaction are deliberately
 * separate. If billing fails, the completed call can be billed on a safe retry.
 *
 * Calls that never started are finalized with zero usage and no charge.
 */
export async function endCall(callId, reason = "completed") {
  const normalizedCallId = validateId(callId, "call ID");
  const normalizedReason = validateEndReason(reason);

  const callRef = callsCollection.doc(normalizedCallId);

  const endedCall = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);

    if (!snapshot.exists) {
      throw makeError("Call not found.", 404);
    }

    const call = snapshot.data();

    if (
      typeof call.userId !== "string" ||
      typeof call.hostId !== "string"
    ) {
      throw makeError("Call participant data is invalid.", 500);
    }

    const userId = validateId(call.userId, "user ID");
    const hostId = validateId(call.hostId, "host ID");

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);

    // All transaction reads happen before writes.
    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    const now = new Date();

    if (call.status === "completed") {
      // Safe cleanup for older completed calls whose reservations were left
      // behind. Reservations are cleared only if they still reference this call.
      releaseReservation(
        transaction,
        userSnapshot,
        normalizedCallId,
        now
      );

      releaseReservation(
        transaction,
        hostSnapshot,
        normalizedCallId,
        now
      );

      return {
        id: snapshot.id,
        ...call,
        alreadyEnded: true,
      };
    }

    if (!ACTIVE_STATUSES.has(call.status)) {
      throw makeError(
        "This call cannot be ended from its current state.",
        409
      );
    }

    const startedAt = toDate(call.startedAt);

    if (call.startedAt && !startedAt) {
      throw makeError(
        "The call start timestamp is invalid. Billing was not changed.",
        500
      );
    }

    const durationSeconds = startedAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - startedAt.getTime()) / 1000)
        )
      : 0;

    const minutesUsed =
      startedAt && durationSeconds > 0
        ? Math.ceil(durationSeconds / 60)
        : 0;

    const neverStarted = !startedAt;

    const update = {
      status: "completed",
      endedAt: now,
      durationSeconds,
      minutesUsed,
      billableMinutes: 0,
      endReason: normalizedReason,
      updatedAt: now,

      // A never-started call has no billable usage. Finalize it without
      // invoking the normal billing transaction.
      ...(neverStarted
        ? {
            billingStatus: "finalized",
            billedAt: now,
            billingError: null,

            customerCharge: 0,
            hostEarnings: 0,
            saLiveRevenue: 0,

            customerChargeCents: 0,
            hostEarningsCents: 0,
            saLiveRevenueCents: 0,
          }
        : {
            billingStatus: "pending",
            billingError: null,
          }),
    };

    transaction.update(callRef, update);

    releaseReservation(
      transaction,
      userSnapshot,
      normalizedCallId,
      now
    );

    releaseReservation(
      transaction,
      hostSnapshot,
      normalizedCallId,
      now
    );

    return {
      id: snapshot.id,
      ...call,
      ...update,
      neverStarted,
    };
  });

  // Never-started calls were already finalized at zero cost.
  if (endedCall.neverStarted) {
    const latestCall = await getCallById(endedCall.id);

    return latestCall ?? endedCall;
  }

  // Do not skip billing just because the call was already ended. A previous
  // attempt might have completed the call but failed before billing finished.
  try {
    const billing = await finalizeCallBilling(endedCall.id);
    const latestCall = await getCallById(endedCall.id);

    console.info("SA LIVE call finalization completed.", {
      callId: endedCall.id,
      callStatus: latestCall?.status ?? endedCall.status,
      billingStatus:
        latestCall?.billingStatus ??
        billing?.billingStatus ??
        "unknown",
    });

    return {
      ...(latestCall ?? endedCall),
      billing,
    };
  } catch (error) {
    console.error("SA LIVE call billing finalization failed.", {
      callId: endedCall.id,
      message:
        typeof error?.message === "string"
          ? error.message.slice(0, 300)
          : "Unknown billing error",
    });

    // The call remains completed and can be retried by trusted backend code.
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* GET USER CALL HISTORY                                                      */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* GET HOST CALL HISTORY                                                      */
/* -------------------------------------------------------------------------- */

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
