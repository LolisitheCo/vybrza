
import { db } from "../config/firebase.js";
import { finalizeCallBilling } from "./billingService.js";
import { removeCallFromGroupRoom } from "./groupRoomService.js";

// ============================================================
// SA LIVE — CALL SERVICE
// Group calls: 1 host + maximum 5 customers
// ============================================================

const callSessions = db.collection("callSessions");
const users = db.collection("users");
const hosts = db.collection("hosts");
const callRooms = db.collection("callRooms");

const ACTIVE_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

const TERMINAL_STATUSES = new Set([
  "ended",
  "completed",
  "cancelled",
  "canceled",
  "failed",
  "expired",
]);

const ALLOWED_END_REASONS = new Set([
  "completed",
  "user_ended",
  "host_ended",
  "insufficient_balance",
  "connection_lost",
  "admin_ended",
  "system_error",
]);

const MAX_ID_LENGTH = 150;

// ============================================================
// GENERAL HELPERS
// ============================================================

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName = "ID") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > MAX_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value.trim())
  ) {
    throw makeError(`A valid ${fieldName} is required.`);
  }

  return value.trim();
}

function validateRoomId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    !/^[A-Za-z0-9_-]+$/.test(value.trim())
  ) {
    throw makeError("A valid LiveKit room ID is required.");
  }

  return value.trim();
}

function validateRoomUrl(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 1000
  ) {
    throw makeError("A valid LiveKit room URL is required.");
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw makeError("The LiveKit room URL is invalid.");
  }

  if (
    !["https:", "wss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw makeError("The LiveKit room URL is invalid.");
  }

  return value.trim();
}

function timestampMillis(value) {
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

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    return null;
  }

  return minutes;
}

function normalizeRemainder(value) {
  const remainder = Number(value ?? 0);

  if (
    !Number.isSafeInteger(remainder) ||
    remainder < 0 ||
    remainder > 59
  ) {
    return null;
  }

  return remainder;
}

function isTerminalCall(call) {
  if (!call) return true;
  if (call.endedAt) return true;

  return TERMINAL_STATUSES.has(
    String(call.status || "").toLowerCase()
  );
}

function getCustomerId(call) {
  return call?.userId || call?.customerUid || null;
}

function isGroupCall(call) {
  return Boolean(call?.groupRoomId);
}

function getSortedCalls(snapshot) {
  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .sort((a, b) => {
      const aTime =
        timestampMillis(a.createdAt) ||
        timestampMillis(a.startedAt);

      const bTime =
        timestampMillis(b.createdAt) ||
        timestampMillis(b.startedAt);

      return bTime - aTime;
    });
}

// ============================================================
// RESERVATION CLEANUP
// ============================================================

function releaseCustomerReservation(
  transaction,
  userSnapshot,
  callId
) {
  if (!userSnapshot?.exists) return;

  const user = userSnapshot.data();

  if (user.activeCallId === callId) {
    transaction.update(userSnapshot.ref, {
      activeCallId: null,
      updatedAt: new Date(),
    });
  }
}

function releaseHostReservation(
  transaction,
  hostSnapshot,
  callId,
  groupCall
) {
  if (!hostSnapshot?.exists) return;

  const host = hostSnapshot.data();

  // Group calls share one host reservation across customers.
  // Never clear the group reservation when one customer leaves.
  if (groupCall) {
    if (host.activeCallId === callId) {
      transaction.update(hostSnapshot.ref, {
        activeCallId: null,
        updatedAt: new Date(),
      });
    }

    return;
  }

  if (host.activeCallId === callId) {
    transaction.update(hostSnapshot.ref, {
      activeCallId: null,
      updatedAt: new Date(),
    });
  }
}

// ============================================================
// CREATE CALL SESSION
// ============================================================

export async function createCallSession({
  userId,
  hostId,
}) {
  const normalizedUserId = validateId(
    userId,
    "customer ID"
  );

  const normalizedHostId = validateId(
    hostId,
    "host ID"
  );

  if (normalizedUserId === normalizedHostId) {
    throw makeError("A host cannot call themselves.");
  }

  const now = new Date();
  const callRef = callSessions.doc();

  const callData = {
    userId: normalizedUserId,
    customerUid: normalizedUserId,
    hostId: normalizedHostId,

    status: "matching",

    groupRoomId: null,
    roomId: null,
    roomUrl: null,

    createdAt: now,
    updatedAt: now,

    startedAt: null,
    endedAt: null,

    durationSeconds: 0,
    minutesUsed: 0,
    billableMinutes: 0,

    billingStatus: "pending",
    endReason: null,

    customerChargeCents: 0,
    hostEarningsCents: 0,
    saRevenueCents: 0,

    hostPayoutStatus: "pending",
  };

  await callRef.set(callData);

  return {
    id: callRef.id,
    ...callData,
  };
}

// ============================================================
// GET CALL BY ID
// ============================================================

export async function getCallById(callId) {
  const normalizedCallId = validateId(
    callId,
    "call ID"
  );

  const snapshot = await callSessions
    .doc(normalizedCallId)
    .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

// ============================================================
// START CALL
//
// IMPORTANT SECURITY CHECKS:
// 1. Customer must still own this active request.
// 2. Host must still own the correct reservation.
// 3. Group room must still contain this customer and call.
// 4. Group room must belong to this host.
// 5. Customer must still have available minutes.
// All checks happen inside one Firestore transaction.
// ============================================================

export async function startCall(
  callId,
  roomId,
  roomUrl
) {
  const normalizedCallId = validateId(
    callId,
    "call ID"
  );

  const normalizedRoomId = validateRoomId(roomId);
  const normalizedRoomUrl = validateRoomUrl(roomUrl);

  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    // --------------------------------------------------------
    // READ 1 — CALL
    // --------------------------------------------------------

    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      throw makeError("Call session not found.", 404);
    }

    const call = callSnapshot.data();

    const customerId = validateId(
      getCustomerId(call),
      "customer ID"
    );

    const hostId = validateId(
      call.hostId,
      "host ID"
    );

    if (isTerminalCall(call)) {
      throw makeError(
        "This call has already ended.",
        409
      );
    }

    if (!ACTIVE_STATUSES.has(call.status)) {
      throw makeError(
        "This call cannot be started.",
        409
      );
    }

    if (
      call.roomId &&
      call.roomId !== normalizedRoomId
    ) {
      throw makeError(
        "The supplied room does not match the assigned call room.",
        409
      );
    }

    const groupCall = isGroupCall(call);

    // --------------------------------------------------------
    // READ 2 — CUSTOMER AND HOST
    // --------------------------------------------------------

    const userRef = users.doc(customerId);
    const hostRef = hosts.doc(hostId);

    const [userSnapshot, hostSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(hostRef),
    ]);

    if (!userSnapshot.exists) {
      throw makeError("Customer account not found.", 404);
    }

    if (!hostSnapshot.exists) {
      throw makeError("Host account not found.", 404);
    }

    const user = userSnapshot.data();
    const host = hostSnapshot.data();

    // --------------------------------------------------------
    // CUSTOMER RESERVATION CHECK
    // --------------------------------------------------------

    if (user.activeCallId !== normalizedCallId) {
      throw makeError(
        "The customer's call reservation is no longer valid.",
        409
      );
    }

    if (
      user.accountStatus &&
      user.accountStatus !== "active"
    ) {
      throw makeError(
        "Customer account is not active.",
        403
      );
    }

    // --------------------------------------------------------
    // HOST ACCOUNT CHECK
    // --------------------------------------------------------

    if (
      host.status !== "active" ||
      !host.firebaseUid
    ) {
      throw makeError(
        "The assigned host is no longer active.",
        409
      );
    }

    // --------------------------------------------------------
    // READ 3 — GROUP ROOM, WHEN APPLICABLE
    // --------------------------------------------------------

    let roomRef = null;
    let roomSnapshot = null;
    let room = null;

    if (groupCall) {
      const groupRoomId = validateId(
        call.groupRoomId,
        "group room ID"
      );

      roomRef = callRooms.doc(groupRoomId);

      roomSnapshot = await transaction.get(roomRef);

      if (!roomSnapshot.exists) {
        throw makeError(
          "The assigned group room no longer exists.",
          409
        );
      }

      room = roomSnapshot.data();

      // ------------------------------------------------------
      // GROUP ROOM VALIDATION
      // ------------------------------------------------------

      if (
        room.hostId !== hostId ||
        room.roomName !== normalizedRoomId
      ) {
        throw makeError(
          "The group room does not match this call.",
          409
        );
      }

      if (
        !["waiting_host", "active"].includes(room.status) ||
        room.endedAt
      ) {
        throw makeError(
          "The group room is no longer available.",
          409
        );
      }

      if (
        !Array.isArray(room.customerIds) ||
        !Array.isArray(room.callIds) ||
        !room.customerIds.includes(customerId) ||
        !room.callIds.includes(normalizedCallId)
      ) {
        throw makeError(
          "The customer is not a member of this group room.",
          403
        );
      }

      // ------------------------------------------------------
      // HOST GROUP RESERVATION
      // ------------------------------------------------------

      if (host.activeGroupRoomId !== call.groupRoomId) {
        throw makeError(
          "The host's group-room reservation is no longer valid.",
          409
        );
      }

      // A group host must not simultaneously hold a
      // separate one-to-one reservation.
      if (host.activeCallId) {
        throw makeError(
          "The host has another active call reservation.",
          409
        );
      }
    } else {
      // ------------------------------------------------------
      // LEGACY ONE-TO-ONE RESERVATION
      // ------------------------------------------------------

      if (host.activeCallId !== normalizedCallId) {
        throw makeError(
          "The host's call reservation is no longer valid.",
          409
        );
      }

      if (host.activeGroupRoomId) {
        throw makeError(
          "The host is already assigned to a group room.",
          409
        );
      }
    }

    // --------------------------------------------------------
    // CUSTOMER BALANCE VALIDATION
    // --------------------------------------------------------

    const minutes = normalizeMinutes(user.minutes);

    const remainder = normalizeRemainder(
      user.secondsUsedRemainder
    );

    if (minutes === null || remainder === null) {
      throw makeError(
        "Customer balance information is invalid.",
        409
      );
    }

    const availableSeconds =
      minutes * 60 - remainder;

    if (availableSeconds <= 0) {
      throw makeError(
        "Customer has insufficient minutes to start this call.",
        402
      );
    }

    // --------------------------------------------------------
    // IDEMPOTENT ACTIVE CALL
    // --------------------------------------------------------

    if (call.status === "active") {
      if (
        call.roomId !== normalizedRoomId ||
        call.roomUrl !== normalizedRoomUrl
      ) {
        throw makeError(
          "This call is already active in another room.",
          409
        );
      }

      // Repair room status if the call is active but the
      // group-room status was not updated.
      if (groupCall && room.status !== "active") {
        transaction.update(roomRef, {
          status: "active",
          startedAt: room.startedAt || call.startedAt || new Date(),
          updatedAt: new Date(),
        });
      }

      return {
        success: true,
        alreadyStarted: true,
        call: {
          id: callSnapshot.id,
          ...call,
        },
      };
    }

    // --------------------------------------------------------
    // ONLY MATCHED CALLS MAY START
    // --------------------------------------------------------

    if (call.status !== "matched") {
      throw makeError(
        "The host has not accepted this call yet.",
        409
      );
    }

    const now = new Date();

    // --------------------------------------------------------
    // ALL READS COMPLETE — BEGIN WRITES
    // --------------------------------------------------------

    transaction.update(callRef, {
      status: "active",

      // Keep a canonical customer ID for billing.
      userId: customerId,
      customerUid: customerId,

      roomId: normalizedRoomId,
      roomUrl: normalizedRoomUrl,

      startedAt: now,
      updatedAt: now,

      minutesAtStart: minutes,
      secondsUsedRemainderAtStart: remainder,
      availableSecondsAtStart: availableSeconds,
    });

    if (groupCall) {
      transaction.update(roomRef, {
        status: "active",
        startedAt: room.startedAt || now,
        updatedAt: now,
      });
    }

    return {
      success: true,
      alreadyStarted: false,

      call: {
        id: callSnapshot.id,
        ...call,
        userId: customerId,
        customerUid: customerId,
        status: "active",
        roomId: normalizedRoomId,
        roomUrl: normalizedRoomUrl,
        startedAt: now,
        updatedAt: now,
        minutesAtStart: minutes,
        secondsUsedRemainderAtStart: remainder,
        availableSecondsAtStart: availableSeconds,
      },
    };
  });
}

// ============================================================
// END CALL
//
// Billing is finalized after the call has been safely marked
// completed. A failed billing attempt remains pending and can
// be retried by calling endCall again.
// ============================================================

export async function endCall(
  callId,
  reason = "completed"
) {
  const normalizedCallId = validateId(
    callId,
    "call ID"
  );

  if (!ALLOWED_END_REASONS.has(reason)) {
    throw makeError("Invalid call end reason.");
  }

  const callRef = callSessions.doc(normalizedCallId);

  const transactionResult = await db.runTransaction(
    async (transaction) => {
      // ------------------------------------------------------
      // READ 1 — CALL
      // ------------------------------------------------------

      const callSnapshot = await transaction.get(callRef);

      if (!callSnapshot.exists) {
        throw makeError("Call session not found.", 404);
      }

      const call = callSnapshot.data();

      const customerId = validateId(
        getCustomerId(call),
        "customer ID"
      );

      const hostId = validateId(
        call.hostId,
        "host ID"
      );

      const userRef = users.doc(customerId);
      const hostRef = hosts.doc(hostId);

      // ------------------------------------------------------
      // READ 2 — CUSTOMER AND HOST
      // ------------------------------------------------------

      const [userSnapshot, hostSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(hostRef),
      ]);

      const groupCall = isGroupCall(call);

      // ------------------------------------------------------
      // ALREADY COMPLETED — ALLOW BILLING RETRY
      // ------------------------------------------------------

      if (call.status === "completed") {
        releaseCustomerReservation(
          transaction,
          userSnapshot,
          normalizedCallId
        );

        releaseHostReservation(
          transaction,
          hostSnapshot,
          normalizedCallId,
          groupCall
        );

        return {
          call: {
            id: callSnapshot.id,
            ...call,
          },
          alreadyEnded: true,
          shouldFinalizeBilling:
            call.billingStatus === "pending" &&
            Boolean(call.startedAt),
          shouldRemoveFromRoom: groupCall,
        };
      }

      // ------------------------------------------------------
      // OTHER TERMINAL STATUSES
      // ------------------------------------------------------

      if (isTerminalCall(call)) {
        return {
          call: {
            id: callSnapshot.id,
            ...call,
          },
          alreadyEnded: true,
          shouldFinalizeBilling: false,
          shouldRemoveFromRoom: false,
        };
      }

      if (!ACTIVE_STATUSES.has(call.status)) {
        throw makeError(
          "This call cannot be ended in its current state.",
          409
        );
      }

      const now = new Date();

      const startedAtMillis = timestampMillis(
        call.startedAt
      );

      const hasStarted = startedAtMillis > 0;

      const durationSeconds = hasStarted
        ? Math.max(
            0,
            Math.floor(
              (now.getTime() - startedAtMillis) / 1000
            )
          )
        : 0;

      const minutesUsed = hasStarted
        ? Math.ceil(durationSeconds / 60)
        : 0;

      // ------------------------------------------------------
      // COMPLETE CALL
      // ------------------------------------------------------

      transaction.update(callRef, {
        status: "completed",

        // Canonical ID supports billing and older records.
        userId: customerId,
        customerUid: customerId,

        endedAt: now,
        updatedAt: now,

        durationSeconds,
        minutesUsed,

        // The billing service calculates the final charge.
        billableMinutes: 0,

        billingStatus: hasStarted
          ? "pending"
          : "not_required",

        endReason: reason,
      });

      // ------------------------------------------------------
      // RELEASE CUSTOMER RESERVATION
      // ------------------------------------------------------

      releaseCustomerReservation(
        transaction,
        userSnapshot,
        normalizedCallId
      );

      // ------------------------------------------------------
      // RELEASE HOST RESERVATION
      // ------------------------------------------------------

      // A group host stays reserved until the entire group
      // room has ended. One customer's departure must not
      // release the host for another call.
      releaseHostReservation(
        transaction,
        hostSnapshot,
        normalizedCallId,
        groupCall
      );

      return {
        call: {
          id: callSnapshot.id,
          ...call,
          userId: customerId,
          customerUid: customerId,
          status: "completed",
          endedAt: now,
          updatedAt: now,
          durationSeconds,
          minutesUsed,
          billableMinutes: 0,
          billingStatus: hasStarted
            ? "pending"
            : "not_required",
          endReason: reason,
        },
        alreadyEnded: false,
        shouldFinalizeBilling: hasStarted,
        shouldRemoveFromRoom: groupCall,
      };
    }
  );

  // ==========================================================
  // GROUP ROOM CLEANUP
  // ==========================================================

  if (transactionResult.shouldRemoveFromRoom) {
    try {
      await removeCallFromGroupRoom({
        callId: normalizedCallId,
      });
    } catch (error) {
      // Billing must still be attempted. A later endCall retry
      // can retry room cleanup as well.
      console.error(
        "[SA LIVE] Group room cleanup failed:",
        normalizedCallId,
        error.message
      );
    }
  }

  // ==========================================================
  // NO BILLING FOR CALLS THAT NEVER STARTED
  // ==========================================================

  if (!transactionResult.shouldFinalizeBilling) {
    return await getCallById(normalizedCallId);
  }

  // ==========================================================
  // FINALIZE BILLING
  // ==========================================================

  try {
    await finalizeCallBilling(normalizedCallId);

    console.log(
      "[SA LIVE] Call billing finalized:",
      normalizedCallId
    );
  } catch (error) {
    console.error(
      "[SA LIVE] Call billing failed:",
      normalizedCallId,
      error.message
    );

    // Preserve the completed call and pending billing status.
    // Do not reverse or manually recalculate any balances.
    try {
      await callRef.update({
        billingError: String(error.message || "Billing failed")
          .slice(0, 500),
        billingErrorAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (updateError) {
      console.error(
        "[SA LIVE] Could not record billing error:",
        updateError.message
      );
    }

    throw error;
  }

  return await getCallById(normalizedCallId);
}

// ============================================================
// CUSTOMER CALL HISTORY
// ============================================================

export async function getUserCallHistory(userId) {
  const normalizedUserId = validateId(
    userId,
    "customer ID"
  );

  const snapshot = await callSessions
    .where("userId", "==", normalizedUserId)
    .get();

  return getSortedCalls(snapshot);
}

// ============================================================
// HOST CALL HISTORY
// ============================================================

export async function getHostCallHistory(hostId) {
  const normalizedHostId = validateId(
    hostId,
    "host ID"
  );

  const snapshot = await callSessions
    .where("hostId", "==", normalizedHostId)
    .get();

  return getSortedCalls(snapshot);
}
