
import { db } from "../config/firebase.js";
import {
  getHostCallHistory,
} from "../services/callService.js";

const callsCollection = db.collection("callSessions");

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;
const ACTIVE_REQUEST_STATUSES = new Set(["matching", "matched"]);

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
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

// Only return fields the host needs to display a call.
// Never expose internal billing, payment, or security data here.
function toHostCallResponse(docId, call) {
  return {
    id: docId,
    hostId: call.hostId ?? null,
    userId: call.userId ?? null,
    status: call.status ?? null,
    createdAt: call.createdAt ?? null,
    updatedAt: call.updatedAt ?? null,
    startedAt: call.startedAt ?? null,
    endedAt: call.endedAt ?? null,
    durationSeconds: Number(call.durationSeconds ?? 0),
    endReason: call.endReason ?? null,
  };
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
      return sendError(
        res,
        401,
        "Authenticated host account required."
      );
    }

    const snapshot = await callsCollection
      .where("hostId", "==", hostId)
      .get();

    const requests = sortNewestFirst(
      snapshot.docs
        .filter((doc) => {
          const call = doc.data();

          return (
            ACTIVE_REQUEST_STATUSES.has(call.status) &&
            !call.endedAt
          );
        })
        .map((doc) => toHostCallResponse(doc.id, doc.data()))
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
      return sendError(
        res,
        401,
        "Authenticated host account required."
      );
    }

    const history = await getHostCallHistory(hostId);

    // Re-filter by the authenticated host and return only safe fields.
    const calls = sortNewestFirst(
      (Array.isArray(history) ? history : [])
        .filter((call) => call.hostId === hostId)
        .map((call) =>
          toHostCallResponse(call.id, call)
        )
    );

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
| Only the assigned host may accept a matching call.
| LiveKit room creation and token generation will be handled
| separately in the call-service integration.
|--------------------------------------------------------------------------
*/

export async function acceptCallRequest(req, res, next) {
  try {
    const hostId = req.hostAccount?.id;
    const callId = req.params.callId;

    if (!hostId) {
      return sendError(
        res,
        401,
        "Authenticated host account required."
      );
    }

    if (
      typeof callId !== "string" ||
      !CALL_ID_PATTERN.test(callId)
    ) {
      return sendError(res, 400, "A valid call ID is required.");
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
      call: toHostCallResponse(
        acceptedCall.id,
        acceptedCall
      ),
    });
  } catch (error) {
    if ([403, 404, 409].includes(error.status)) {
      return sendError(
        res,
        error.status,
        error.message
      );
    }

    return next(error);
  }
}
