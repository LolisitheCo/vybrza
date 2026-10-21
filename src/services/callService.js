import { db } from "../config/firebase.js";

const callsCollection = db.collection("callSessions");

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function toCall(doc) {
  if (!doc.exists) {
    return null;
  }

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

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

/*
|--------------------------------------------------------------------------
| CREATE CALL SESSION
|--------------------------------------------------------------------------
*/

export async function createCallSession({
  userId,
  hostId,
}) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    typeof hostId !== "string" ||
    !hostId.trim()
  ) {
    throw new Error("Valid user and host IDs are required.");
  }

  const now = new Date();
  const callRef = callsCollection.doc();

  const callData = {
    userId: userId.trim(),
    hostId: hostId.trim(),

    status: "matching",

    roomId: null,
    roomUrl: null,

    startedAt: null,
    endedAt: null,

    durationSeconds: 0,
    minutesUsed: 0,

    endReason: null,

    billingStatus: "pending",
    billedAt: null,

    hostEarnings: 0,
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
  if (
    typeof callId !== "string" ||
    !callId.trim()
  ) {
    throw new Error("A valid call ID is required.");
  }

  const snapshot = await callsCollection
    .doc(callId)
    .get();

  return toCall(snapshot);
}

/*
|--------------------------------------------------------------------------
| START CALL
|--------------------------------------------------------------------------
| A call can only start once.
|--------------------------------------------------------------------------
*/

export async function startCall(
  callId,
  roomId,
  roomUrl
) {
  if (
    typeof callId !== "string" ||
    !callId.trim() ||
    typeof roomId !== "string" ||
    !roomId.trim() ||
    typeof roomUrl !== "string" ||
    !roomUrl.trim()
  ) {
    throw new Error(
      "Call ID, room ID, and room URL are required."
    );
  }

  const callRef = callsCollection.doc(callId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);

    if (!snapshot.exists) {
      throw new Error("Call not found.");
    }

    const call = snapshot.data();

    if (call.status !== "matched") {
      throw new Error(
        "Only a matched call can be started."
      );
    }

    if (call.startedAt || call.endedAt) {
      throw new Error(
        "This call has already started or ended."
      );
    }

    const now = new Date();

    transaction.update(callRef, {
      status: "active",
      roomId,
      roomUrl,
      startedAt: now,
      updatedAt: now,
    });

    return {
      id: callRef.id,
      ...call,
      status: "active",
      roomId,
      roomUrl,
      startedAt: now,
      updatedAt: now,
    };
  });
}

/*
|--------------------------------------------------------------------------
| END CALL
|--------------------------------------------------------------------------
| Marks the call as completed exactly once.
| Billing and host earnings must be handled separately.
|--------------------------------------------------------------------------
*/

export async function endCall(
  callId,
  reason = "completed"
) {
  if (
    typeof callId !== "string" ||
    !callId.trim()
  ) {
    throw new Error("A valid call ID is required.");
  }

  const allowedReasons = new Set([
    "completed",
    "user_ended",
    "host_ended",
    "insufficient_balance",
    "connection_lost",
    "admin_ended",
    "system_error",
  ]);

  if (!allowedReasons.has(reason)) {
    throw new Error("Invalid call end reason.");
  }

  const callRef = callsCollection.doc(callId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);

    if (!snapshot.exists) {
      throw new Error("Call not found.");
    }

    const call = snapshot.data();

    if (call.status === "completed") {
      return {
        id: snapshot.id,
        ...call,
        alreadyEnded: true,
      };
    }

    if (
      call.status !== "active" &&
      call.status !== "matching" &&
      call.status !== "matched"
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

    const updatedCall = {
      status: "completed",
      endedAt: now,
      durationSeconds,

      // Round up partial minutes for billing calculations.
      // The billing service must apply the approved pricing rules.
      minutesUsed: Math.ceil(durationSeconds / 60),

      endReason: reason,

      billingStatus: "pending",
      billedAt: null,

      updatedAt: now,
    };

    transaction.update(callRef, updatedCall);

    return {
      id: snapshot.id,
      ...call,
      ...updatedCall,
    };
  });
}

/*
|--------------------------------------------------------------------------
| GET USER CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getUserCallHistory(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    throw new Error("A valid user ID is required.");
  }

  const snapshot = await callsCollection
    .where("userId", "==", userId)
    .get();

  const calls = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  calls.sort((a, b) => {
    const aTime = toDate(a.createdAt)?.getTime() || 0;
    const bTime = toDate(b.createdAt)?.getTime() || 0;

    return bTime - aTime;
  });

  return calls;
}

/*
|--------------------------------------------------------------------------
| GET HOST CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getHostCallHistory(hostId) {
  if (
    typeof hostId !== "string" ||
    !hostId.trim()
  ) {
    throw new Error("A valid host ID is required.");
  }

  const snapshot = await callsCollection
    .where("hostId", "==", hostId)
    .get();

  const calls = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  calls.sort((a, b) => {
    const aTime = toDate(a.createdAt)?.getTime() || 0;
    const bTime = toDate(b.createdAt)?.getTime() || 0;

    return bTime - aTime;
  });

  return calls;
}