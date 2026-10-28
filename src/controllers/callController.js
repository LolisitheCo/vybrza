
import { db } from "../config/firebase.js";
import { getHostCallHistory } from "../services/callService.js";

const callSessions = db.collection("callSessions");

const ACTIVE_REQUEST_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function safeCallResponse(id, data) {
  return {
    id,
    hostId: data.hostId ?? null,
    userId: data.userId ?? null,
    status: data.status ?? "unknown",
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
    startedAt: data.startedAt ?? null,
    endedAt: data.endedAt ?? null,
    durationSeconds: Number(data.durationSeconds ?? 0),
    endReason: data.endReason ?? null,
  };
}

function getAuthenticatedHostId(req) {
  const hostId = req.hostAccount?.id;

  return typeof hostId === "string" && hostId.trim()
    ? hostId.trim()
    : null;
}

function getTimestampMs(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

// GET /api/calls/requests
export async function getMyCallRequests(req, res, next) {
  try {
    const hostId = getAuthenticatedHostId(req);

    if (!hostId) {
      return sendError(
        res,
        401,
        "An authenticated host account is required."
      );
    }

    const snapshot = await callSessions
      .where("hostId", "==", hostId)
      .get();

    const now = Date.now();

    const calls = snapshot.docs
      .map((doc) => safeCallResponse(doc.id, doc.data()))
      .filter((call) => {
        if (call.endedAt) return false;

        if (!ACTIVE_REQUEST_STATUSES.has(call.status)) {
          return false;
        }

        // Keep active calls visible, regardless of age.
        if (call.status === "active" || call.startedAt) {
          return true;
        }

        const createdMs = getTimestampMs(call.createdAt);

        // Keep records without timestamps visible for investigation.
        if (!createdMs) return true;

        // Hide old, unstarted requests from the dashboard.
        return now - createdMs <= REQUEST_TIMEOUT_MS;
      })
      .sort((a, b) => {
        return (
          getTimestampMs(b.createdAt) -
          getTimestampMs(a.createdAt)
        );
      });

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      calls,
    });
  } catch (error) {
    return next(error);
  }
}

// GET /api/calls/history
export async function getMyCallHistory(req, res, next) {
  try {
    const hostId = getAuthenticatedHostId(req);

    if (!hostId) {
      return sendError(
        res,
        401,
        "An authenticated host account is required."
      );
    }

    const calls = await getHostCallHistory(hostId);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      calls: Array.isArray(calls)
        ? calls.map((call) => safeCallResponse(call.id, call))
        : [],
    });
  } catch (error) {
    return next(error);
  }
}

// POST /api/calls/:callId/accept
export async function acceptCallRequest(req, res, next) {
  try {
    const hostId = getAuthenticatedHostId(req);

    if (!hostId) {
      return sendError(
        res,
        401,
        "An authenticated host account is required."
      );
    }

    const callId =
      typeof req.params.callId === "string"
        ? req.params.callId.trim()
        : "";

    if (!callId || callId.length > 200) {
      return sendError(res, 400, "A valid call ID is required.");
    }

    const callRef = callSessions.doc(callId);

    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(callRef);

      if (!snapshot.exists) {
        return {
          status: 404,
          body: {
            success: false,
            message: "Call not found.",
          },
        };
      }

      const call = snapshot.data();

      if (call.hostId !== hostId) {
        return {
          status: 403,
          body: {
            success: false,
            message: "This call is not assigned to your host account.",
          },
        };
      }

      if (call.endedAt || call.status === "completed") {
        return {
          status: 409,
          body: {
            success: false,
            message: "This call has already ended.",
          },
        };
      }

      if (call.status === "matched" || call.status === "active") {
        return {
          status: 200,
          body: {
            success: true,
            message:
              call.status === "active"
                ? "This call is already active."
                : "This call is already assigned and ready to join.",
            call: safeCallResponse(snapshot.id, call),
          },
        };
      }

      if (call.status !== "matching") {
        return {
          status: 409,
          body: {
            success: false,
            message: "This call cannot be accepted in its current state.",
          },
        };
      }

      const now = new Date();

      transaction.update(callRef, {
        status: "matched",
        updatedAt: now,
      });

      return {
        status: 200,
        body: {
          success: true,
          message: "Call accepted. You can now join the call.",
          call: safeCallResponse(snapshot.id, {
            ...call,
            status: "matched",
            updatedAt: now,
          }),
        },
      };
    });

    res.setHeader("Cache-Control", "no-store");

    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
}
