
import { db } from "../config/firebase.js";
import {
  getHostCallHistory,
} from "../services/callService.js";

const callsCollection = db.collection("callSessions");

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
| GET HOST CALL REQUESTS
|--------------------------------------------------------------------------
*/

export async function getMyCallRequests(req, res, next) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    // Query by host ID, then filter statuses in the server.
    const snapshot = await callsCollection
      .where("hostId", "==", hostId)
      .get();

    const requests = sortNewestFirst(
      snapshot.docs
        .map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
        .filter((call) =>
          ["matching", "matched"].includes(call.status)
        )
    );

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      requests,
    });
  } catch (error) {
    return next(error);
  }
}

/*
|--------------------------------------------------------------------------
| GET HOST CALL HISTORY
|--------------------------------------------------------------------------
*/

export async function getMyCallHistory(req, res, next) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const calls = await getHostCallHistory(hostId);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      calls,
    });
  } catch (error) {
    return next(error);
  }
}

/*
|--------------------------------------------------------------------------
| ACCEPT AN ASSIGNED CALL REQUEST
|--------------------------------------------------------------------------
| Only the host assigned to the call can accept it.
| The call must still be in "matching" status.
|--------------------------------------------------------------------------
*/

export async function acceptCallRequest(req, res, next) {
  try {
    const hostId = req.hostAccount?.id;
    const callId = req.params.callId;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    if (
      typeof callId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(callId)
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid call ID is required.",
      });
    }

    const callRef = callsCollection.doc(callId);

    const acceptedCall = await db.runTransaction(
      async (transaction) => {
        const snapshot = await transaction.get(callRef);

        if (!snapshot.exists) {
          const error = new Error("Call request not found.");
          error.status = 404;
          throw error;
        }

        const call = snapshot.data();

        if (call.hostId !== hostId) {
          const error = new Error(
            "This call request is not assigned to your account."
          );
          error.status = 403;
          throw error;
        }

        if (call.status !== "matching") {
          const error = new Error(
            "This call request is no longer available to accept."
          );
          error.status = 409;
          throw error;
        }

        if (call.startedAt || call.endedAt) {
          const error = new Error(
            "This call cannot be accepted in its current state."
          );
          error.status = 409;
          throw error;
        }

        const now = new Date();

        transaction.update(callRef, {
          status: "matched",
          updatedAt: now,
        });

        return {
          id: snapshot.id,
          ...call,
          status: "matched",
          updatedAt: now,
        };
      }
    );

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Call request accepted.",
      call: acceptedCall,
    });
  } catch (error) {
    if ([403, 404, 409].includes(error.status)) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
      });
    }

    return next(error);
  }
}
