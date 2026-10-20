import { db } from "../config/firebase.js";

const callsCollection =
  db.collection("callSessions");

/*
|--------------------------------------------------------------------------
| CREATE CALL SESSION
|--------------------------------------------------------------------------
*/

export async function createCallSession({
  userId,
  hostId,
}) {
  const now = new Date();

  const callData = {
    userId,

    hostId,

    status: "matching",

    roomId: null,

    roomUrl: null,

    startedAt: null,

    endedAt: null,

    durationSeconds: 0,

    minutesUsed: 0,

    endReason: null,

    createdAt: now,

    updatedAt: now,
  };

  const docRef =
    await callsCollection.add(
      callData
    );

  return {
    id: docRef.id,
    ...callData,
  };
}

/*
|--------------------------------------------------------------------------
| GET CALL
|--------------------------------------------------------------------------
*/

export async function getCallById(
  callId
) {
  const snapshot =
    await callsCollection
      .doc(callId)
      .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

/*
|--------------------------------------------------------------------------
| START CALL
|--------------------------------------------------------------------------
*/

export async function startCall(
  callId,
  roomId,
  roomUrl
) {
  const callRef =
    callsCollection.doc(
      callId
    );

  const snapshot =
    await callRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Call not found."
    );
  }

  const now = new Date();

  await callRef.update({
    status: "active",

    roomId,

    roomUrl,

    startedAt: now,

    updatedAt: now,
  });

  return getCallById(
    callId
  );
}

/*
|--------------------------------------------------------------------------
| END CALL
|--------------------------------------------------------------------------
*/

export async function endCall(
  callId,
  reason = "completed"
) {
  const callRef =
    callsCollection.doc(
      callId
    );

  const snapshot =
    await callRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Call not found."
    );
  }

  const call =
    snapshot.data();

  const now = new Date();

  let durationSeconds =
    Number(
      call.durationSeconds || 0
    );

  if (
    call.startedAt &&
    !call.endedAt
  ) {
    const startedAt =
      call.startedAt.toDate
        ? call.startedAt.toDate()
        : new Date(
            call.startedAt
          );

    durationSeconds =
      Math.max(
        0,
        Math.floor(
          (now -
            startedAt) /
            1000
        )
      );
  }

  await callRef.update({
    status: "completed",

    endedAt: now,

    durationSeconds,

    endReason: reason,

    updatedAt: now,
  });

  return getCallById(
    callId
  );
}

/*
|--------------------------------------------------------------------------
| GET USER CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getUserCallHistory(
  userId
) {
  const snapshot =
    await callsCollection
      .where(
        "userId",
        "==",
        userId
      )
      .get();

  const calls =
    snapshot.docs.map(
      (doc) => ({
        id: doc.id,
        ...doc.data(),
      })
    );

  calls.sort(
    (a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return (
        bTime - aTime
      );
    }
  );

  return calls;
}