import { db } from "../config/firebase.js";
import { finalizeCallBilling } from "./billingService.js";
import { removeCallFromGroupRoom } from "./groupRoomService.js";

// ============================================================
// SA LIVE — CALL SERVICE
// One host + maximum five customers
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
// HELPERS
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

  // Group room reservation remains until the final
  // customer leaves the room.
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
//
// Compatibility function only.
//
// Customer matching should use matchingService.js.
// Do not create a second call session when a customer
// request has already been created by matchUserToHost().
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

    minutesAtStart: null,
    secondsUsedRemainderAtStart: null,
    availableSecondsAtStart: null,

    billingStatus: "pending",
    endReason: null,

    customerCharge: 0,
    hostEarnings: 0,
    saLiveRevenue: 0,

    customerChargeCents: 0,
    hostEarningsCents: 0,
    saLiveRevenueCents: 0,

    hostPayoutStatus: "pending",
  };

  await callRef.create(callData);

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
// ============================================================

export async function startCall(
  callId,
  roomId,
  roomUrl
) {
  const normalizedCallId = validateId(callId, "call ID");
  const normalizedRoomId = validateRoomId(roomId);
  const normalizedRoomUrl = validateRoomUrl(roomUrl);

  const callRef = callSessions.doc(normalizedCallId);

  return db.runTransaction(async (transaction) => {
    // READ 1 — CALL

    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      throw makeError("Call session not found.", 404);
    }

    const call = callSnapshot.data();

    const customerId = validateId(
      getCustomerId(call),
      "customer ID"
    );

    const hostId = validateId(call.hostId, "host ID");

    if (isTerminalCall(call)) {
      throw makeError("This call has already ended.", 409);
    }

    if (!ACTIVE_STATUSES.has(call.status)) {
      throw makeError("This call cannot be started.", 409);
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

    // READ 2 — CUSTOMER AND HOST

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

    // CUSTOMER RESERVATION

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

    // HOST ACCOUNT

    if (
      host.status !== "active" ||
      typeof host.firebaseUid !== "string" ||
      !host.firebaseUid.trim()
    ) {
      throw makeError(
        "The assigned host is no longer active.",
        409
      );
    }

    // READ 3 — GROUP ROOM

    let roomRef = null;
    let room = null;

    if (groupCall) {
      const groupRoomId = validateId(
        call.groupRoomId,
        "group room ID"
      );

      roomRef = callRooms.doc(groupRoomId);

      const roomSnapshot = await transaction.get(roomRef);

      if (!roomSnapshot.exists) {
        throw makeError(
          "The assigned group room no longer exists.",
          409
        );
      }

      room = roomSnapshot.data();

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

      // Validate paired customer/call membership.

      if (
        !Array.isArray(room.customerIds) ||
        !Array.isArray(room.callIds) ||
        room.customerIds.length !== room.callIds.length ||
        room.customerIds.length > 5 ||
        new Set(room.customerIds).size !== room.customerIds.length ||
        new Set(room.callIds).size !== room.callIds.length ||
        !room.customerIds.every(
          (id) => typeof id === "string" && id.trim()
        ) ||
        !room.callIds.every(
          (id) => typeof id === "string" && id.trim()
        )
      ) {
        throw makeError(
          "The group room membership is invalid.",
          409
        );
      }

      const customerIndex = room.customerIds.indexOf(customerId);
      const callIndex = room.callIds.indexOf(normalizedCallId);

      if (
        customerIndex === -1 ||
        callIndex === -1 ||
        customerIndex !== callIndex
      ) {
        throw makeError(
          "The customer is not a valid member of this group room.",
          403
        );
      }

      if (host.activeGroupRoomId !== call.groupRoomId) {
        throw makeError(
          "The host's group-room reservation is no longer valid.",
          409
        );
      }

      if (host.activeCallId) {
        throw makeError(
          "The host has another active call reservation.",
          409
        );
      }
    } else {
      // LEGACY ONE-TO-ONE RESERVATION

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

    // IDEMPOTENT ACTIVE CALL CHECK
    //
    // Do this before checking remaining balance.
    // A retry of an already-started call must not fail
    // merely because the customer's balance has since changed.

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

      if (groupCall && room.status !== "active") {
        const now = new Date();

        transaction.update(roomRef, {
          status: "active",
          startedAt: room.startedAt || call.startedAt || now,
          updatedAt: now,
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

    // ONLY MATCHED CALLS MAY START

    if (call.status !== "matched") {
      throw makeError(
        "The host has not accepted this call yet.",
        409
      );
    }

    // CUSTOMER BALANCE

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

    const availableSeconds = minutes * 60 - remainder;

    if (availableSeconds <= 0) {
      throw makeError(
        "Customer has insufficient minutes to start this call.",
        402
      );
    }

    // ALL READS COMPLETE — BEGIN WRITES

    const now = new Date();

    transaction.update(callRef, {
      status: "active",

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
// ============================================================

export async function endCall(
  callId,
  reason = "completed"
) {
  const normalizedCallId = validateId(callId, "call ID");

  if (!ALLOWED_END_REASONS.has(reason)) {
    throw makeError("Invalid call end reason.");
  }

  const callRef = callSessions.doc(normalizedCallId);

  const transactionResult = await db.runTransaction(
    async (transaction) => {
      // READ 1 — CALL

      const callSnapshot = await transaction.get(callRef);

      if (!callSnapshot.exists) {
        throw makeError("Call session not found.", 404);
      }

      const call = callSnapshot.data();

      const customerId = validateId(
        getCustomerId(call),
        "customer ID"
      );

      const hostId = validateId(call.hostId, "host ID");

      // READ 2 — CUSTOMER AND HOST

      const userRef = users.doc(customerId);
      const hostRef = hosts.doc(hostId);

      const [userSnapshot, hostSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(hostRef),
      ]);

      const groupCall = isGroupCall(call);

      // ALREADY COMPLETED — RETRY CLEANUP AND BILLING

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

      // OTHER TERMINAL STATUSES

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

      const startedAtMillis = timestampMillis(call.startedAt);
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

      // COMPLETE CALL

      transaction.update(callRef, {
        status: "completed",

        userId: customerId,
        customerUid: customerId,

        endedAt: now,
        updatedAt: now,

        durationSeconds,
        minutesUsed,

        billableMinutes: 0,

        billingStatus: hasStarted
          ? "pending"
          : "not_required",

        endReason: reason,
      });

      // RELEASE CUSTOMER RESERVATION

      releaseCustomerReservation(
        transaction,
        userSnapshot,
        normalizedCallId
      );

      // RELEASE LEGACY HOST RESERVATION.
      // Group host reservation is handled when the last
      // customer leaves the group room.

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

  // GROUP ROOM CLEANUP

  if (transactionResult.shouldRemoveFromRoom) {
    try {
      await removeCallFromGroupRoom({
        callId: normalizedCallId,
      });
    } catch (error) {
      console.error(
        "[SA LIVE] Group room cleanup failed:",
        normalizedCallId,
        error.message
      );
    }
  }

  // CALLS THAT NEVER STARTED ARE NOT BILLED

  if (!transactionResult.shouldFinalizeBilling) {
    return await getCallById(normalizedCallId);
  }

  // FINALIZE BILLING

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

    try {
      await callRef.update({
        billingError: String(
          error.message || "Billing failed"
        ).slice(0, 500),

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