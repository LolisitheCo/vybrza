
import { db } from "../config/firebase.js";
import { getHostCallHistory } from "../services/callService.js";

const callSessions = db.collection("callSessions");

const ACTIVE_REQUEST_STATUSES = new Set(["matching", "matched", "active"]);

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

// GET /api/calls/requests
export async function getMyCallRequests(req, res, next) {
  try {
    const hostId = getAuthenticatedHostId(req);

    if (!hostId) {
      return sendError(res, 401, "An authenticated host account is required.");
    }

    const snapshot = await callSessions
      .where("hostId", "==", hostId)
      .get();

    const calls = snapshot.docs
      .map((doc) => safeCallResponse(doc.id, doc.data()))
      .filter(
        (call) =>
          ACTIVE_REQUEST_STATUSES.has(call.status) &&
          !call.endedAt
      )
      .sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() ?? 0;
        const bTime = b.createdAt?.toMillis?.() ?? 0;
        return bTime - aTime;
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
      return sendError(res, 401, "An authenticated host account is required.");
    }

    const calls = await getHostCallHistory(hostId);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      calls: Array.isArray(calls)
        ? calls.map((call) =>
            safeCallResponse(call.id, call)
          )
        : [],
    });
  } catch (error) {
    return next(error);
  }
}

// POST /api/calls/:callId/accept

 // GET /api/calls/requests
export async function getMyCallRequests(req, res, next) {
  try {
    const hostId = getAuthenticatedHostId(req);

    if (!hostId) {
      return sendError(res, 401, "An authenticated host account is required.");
    }

    const snapshot = await callSessions
      .where("hostId", "==", hostId)
      .get();

    const now = Date.now();
    const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

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

    const calls = snapshot.docs
      .map((doc) => safeCallResponse(doc.id, doc.data()))
      .filter((call) => {
        if (call.endedAt) return false;

        if (!ACTIVE_REQUEST_STATUSES.has(call.status)) {
          return false;
        }

        // Never hide a call that has already started.
        if (call.status === "active" || call.startedAt) {
          return true;
        }

        const createdMs = getTimestampMs(call.createdAt);

        // Keep requests with missing timestamps visible for investigation.
        if (!createdMs) return true;

        // Hide old, unstarted requests from the host dashboard.
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

