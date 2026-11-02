
import { db } from "../config/firebase.js";
import { finalizeCallBilling } from "./billingService.js";
import {
  removeCallFromGroupRoom,
} from "./groupRoomService.js";

const callsCollection = db.collection("callSessions");
const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callRoomsCollection = db.collection("callRooms");

const ALLOWED_END_REASONS = new Set([
  "completed",
  "user_ended",
  "host_ended",
  "insufficient_balance",
  "connection_lost",
  "admin_ended",
  "system_error",
]);

const ACTIVE_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;
const MAX_ROOM_URL_LENGTH = 2048;
const MAX_ROOM_ID_LENGTH = 256;

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

function toCall(snapshot) {
  if (!snapshot?.exists) return null;

  return {
    ...snapshot.data(),
    id: snapshot.id,
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

  return parsed.toString().replace(/\/+$/, "");
}

function validateEndReason(reason) {
  if (
    typeof reason !== "string" ||
    !ALLOWED_END_REASONS.has(reason)
  ) {
    throw makeError("Invalid call end reason.", 400);
  }

  return reason;
}

function isGroupCall(call) {
  return (
    typeof call?.groupRoomId === "string" &&
    call.groupRoomId.trim().length > 0
  );
}

/*
 * Release a reservation only when it still belongs to this call.
 *
 * For group calls, the host's shared reservation must be preserved.
 * The group-room lifecycle is responsible for releasing it.
 */
function releaseReservation(
  transaction,
  snapshot,
  callId,
  now,
  { preserveReservation = false } = {}
) {
  if (!snapshot?.exists || preserveReservation) return;

  const data = snapshot.data();

  if (data.activeCallId !== callId) return;

  transaction.update(snapshot.ref, {
    activeCallId: null,
    updatedAt: now,
  });
}

/*
|--------------------------------------------------------------------------
| CREATE CALL SESSION
|--------------------------------------------------------------------------
*/

export async function createCallSession({ userId, hostId }) {
  const normalizedUserId = validateId(userId, "user ID");
  const normalizedHostId = validateId(hostId, "host ID");

  if (normalizedUserId === normalizedHostId) {
    throw makeError(
      "A user cannot call their own host account.",
      400
    );
  }

  const now = new Date();
  const callRef = callsCollection.doc();

  const callData = {
    userId: normalizedUserId,
    hostId: normalizedHostId,

    status: "matching",

    roomId: null,
    roomUrl: null,
    groupRoomId: null,

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
|
| Trusted backend code must verify that the required participants are
| present in LiveKit before calling this function.
|
| Each customer has an independent call session and timer, even when
| several customers share the same group room.
|--------------------------------------------------------------------------
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

    let groupRoomRef = null;
    let groupRoom = null;

    // Read and validate the shared room when this is a group call.
    if (call.groupRoomId) {
      groupRoomRef = callRoomsCollection.doc(call.groupRoomId);

      const groupRoomSnapshot = await transaction.get(
        groupRoomRef
      );

      if (!groupRoomSnapshot.exists) {
        throw makeError(
          "The assigned group room no longer exists.",
          409
        );
      }

      groupRoom = groupRoomSnapshot.data();

      if (
        !["waiting_host", "active"].includes(groupRoom.status) ||
        groupRoom.endedAt ||
        groupRoom.roomName !== normalizedRoomId ||
        groupRoom.hostId !== call.hostId ||
        !Array.isArray(groupRoom.callIds) ||
        !groupRoom.callIds.includes(normalizedCallId) ||
        !Array.isArray(groupRoom.customerIds) ||
        !groupRoom.customerIds.includes(call.userId)
      ) {
        throw makeError(
          "This customer is no longer eligible to start in this group room.",
          409
        );
      }
    }

    // Identical retries must never reset the timer or balance snapshot.
    if (call.status === "active") {
      if (
        call.roomId !== normalizedRoomId ||
        call.roomUrl !== normalizedRoomUrl
      ) {
        throw makeError(
          "This call is already active in a different room.",
          409
        );
      }

      // Repair the room status if an earlier operation left it waiting.
      if (groupRoomRef && groupRoom.status !== "active") {
        const now = new Date();

        transaction.update(groupRoomRef, {
          status: "active",
          startedAt: groupRoom.startedAt || now,
          updatedAt: now,
        });
      }

      return {
        ...call,
        id: snapshot.id,
      };
    }

    if (call.status !== "matched") {
      throw makeError(
        "Only a matched call can be started.",
        409
      );
    }

    if (call.startedAt || call.endedAt) {
      throw makeError(
        "This call has already started or ended.",
        409
      );
    }

    // Read the customer's balance before making any transaction writes.
    const userId = call.userId || call.customerUid;

    if (
      typeof userId !== "string" ||
      !userId.trim()
    ) {
      throw makeError(
        "Customer ID is missing from this call.",
        409
      );
    }

    const userRef = usersCollection.doc(userId);
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw makeError(
        "Customer account was not found.",
        404
      );
    }

    const customerMinutes = userSnapshot.data().minutes;

    if (
      !Number.isSafeInteger(customerMinutes) ||
      customerMinutes <= 0
    ) {
      throw makeError(
        "Customer has no available minutes.",
        409
      );
    }

    const now = new Date();

    const update = {
      status: "active",
      minutesAtStart: customerMinutes,
      roomId: normalizedRoomId,
      roomUrl: normalizedRoomUrl,
      startedAt: now,
      updatedAt: now,
    };

    // Update the customer's individual session.
    transaction.update(callRef, update);

    // Update the shared room in the SAME transaction.
    if (groupRoomRef) {
      transaction.update(groupRoomRef, {
        status: "active",
        startedAt: groupRoom.startedAt || now,
        updatedAt: now,
      });
    }

    return {
      ...call,
      ...update,
      id: snapshot.id,
    };
  });
}


/*
|--------------------------------------------------------------------------
| END CALL
|--------------------------------------------------------------------------
|
| Every customer call is ended and billed independently.
|
| Group call:
| - releases only this customer's activeCallId;
| - preserves the host's shared group-room reservation;
| - finalizes only this customer's billing.
|
| Legacy one-to-one call:
| - releases this customer's reservation;
| - releases the host's activeCallId if it belongs to this call.
|--------------------------------------------------------------------------
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
      throw makeError(
        "Call participant data is invalid.",
        500
      );
    }

    const userId = validateId(call.userId, "user ID");
    const hostId = validateId(call.hostId, "host ID");

    const userRef = usersCollection.doc(userId);
    const hostRef = hostsCollection.doc(hostId);

    // Firestore requires all transaction reads before writes.
    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    const now = new Date();
    const groupCall = isGroupCall(call);

    /*
     * A previous request may already have completed this call.
     * Still clean up stale reservations and allow pending billing
     * to be retried after the transaction.
     */
    if (call.status === "completed") {
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
        now,
        { preserveReservation: groupCall }
      );

      return {
        ...call,
        id: snapshot.id,
        alreadyEnded: true,
        neverStarted: !toDate(call.startedAt),
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
          Math.floor(
            (now.getTime() - startedAt.getTime()) / 1000
          )
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

      // The billing service calculates the final billable amount.
      billableMinutes: 0,

      endReason: normalizedReason,
      updatedAt: now,

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

    // Always release this customer's own reservation.
    releaseReservation(
      transaction,
      userSnapshot,
      normalizedCallId,
      now
    );

    // Never release the shared group-room host reservation here.
    releaseReservation(
      transaction,
      hostSnapshot,
      normalizedCallId,
      now,
      { preserveReservation: groupCall }
    );

    return {
      ...call,
      ...update,
      id: snapshot.id,
      neverStarted,
    };
  });

    /*
   * Remove this customer's membership from the shared room.
   * Do this before billing so a billing error cannot leave
   * a completed customer occupying a room slot.
   */
  if (isGroupCall(endedCall)) {
    try {
      await removeCallFromGroupRoom({
        callId: endedCall.id,
      });
    } catch (error) {
      console.error(
        "SA LIVE group-room cleanup failed.",
        {
          callId: endedCall.id,
          message:
            typeof error?.message === "string"
              ? error.message.slice(0, 300)
              : "Unknown cleanup error",
        }
      );
    }
  }

  /*
   * Calls that never started must not be billed.
   */
  if (endedCall.neverStarted) {
    const latestCall = await getCallById(endedCall.id);
    return latestCall ?? endedCall;
  }

  /*
   * Already-finalized calls must never be charged again.
   */
  if (endedCall.billingStatus === "finalized") {
    return endedCall;
  }

  /*
   * Billing is deliberately performed outside the transaction.
   * The billing service must be idempotent and transaction-safe.
   */
  try {
    const billing = await finalizeCallBilling(endedCall.id);

    const latestCall = await getCallById(endedCall.id);

    console.info("SA LIVE call billing finalization completed.", {
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

    /*
     * Record the failure only if billing has not already completed.
     * This avoids overwriting a successful result if a concurrent
     * billing attempt finished while this request was failing.
     */
    try {
      await db.runTransaction(async (transaction) => {
        const latestSnapshot = await transaction.get(callRef);

        if (!latestSnapshot.exists) return;

        const latestData = latestSnapshot.data();

        if (
          latestData.status === "completed" &&
          latestData.billingStatus !== "finalized"
        ) {
          transaction.update(callRef, {
            billingError:
              typeof error?.message === "string"
                ? error.message.slice(0, 500)
                : "Billing finalization failed.",
            updatedAt: new Date(),
          });
        }
      });
    } catch (recordError) {
      console.error(
        "Could not record SA LIVE billing error.",
        {
          callId: endedCall.id,
          message:
            typeof recordError?.message === "string"
              ? recordError.message.slice(0, 300)
              : "Unknown error",
        }
      );
    }

    // The call stays completed. A trusted backend retry can finalize billing.
    throw error;
  }
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
      ...doc.data(),
      id: doc.id,
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
      ...doc.data(),
      id: doc.id,
    }))
  );
}
