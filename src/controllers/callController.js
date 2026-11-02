
import { db } from "../config/firebase.js";

import {
  getHostCallHistory,
} from "../services/callService.js";

import {
  attachExistingCallToGroupRoom,
} from "../services/groupRoomService.js";

const callSessions = db.collection("callSessions");

const ACTIVE_REQUEST_STATUSES = new Set([
  "matching",
  "matched",
  "active",
]);

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CALL_ID_LENGTH = 128;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/*
|--------------------------------------------------------------------------
| RESPONSE HELPERS
|--------------------------------------------------------------------------
*/

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...extra,
  });
}

function getAuthenticatedHostId(req) {
  const hostId = req.hostAccount?.id;

  return (
    typeof hostId === "string" &&
    hostId.trim().length > 0
  )
    ? hostId.trim()
    : null;
}

function getTimestampMs(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

function validCallId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CALL_ID_LENGTH &&
    VALID_ID_PATTERN.test(value)
  );
}

/*
|--------------------------------------------------------------------------
| SAFE CALL RESPONSE
|--------------------------------------------------------------------------
|
| Only return fields needed by the host dashboard.
| Never return private customer account or payment information.
|
*/

function safeCallResponse(id, data = {}) {
  return {
    id,

    hostId: data.hostId ?? null,
    userId: data.userId ?? null,

    status: data.status ?? "unknown",

    groupRoomId: data.groupRoomId ?? null,
    roomId: data.roomId ?? null,

    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,

    startedAt: data.startedAt ?? null,
    endedAt: data.endedAt ?? null,

    durationSeconds: Number(data.durationSeconds ?? 0),

    endReason: data.endReason ?? null,
  };
}

function safeCallList(calls) {
  if (!Array.isArray(calls)) {
    return [];
  }

  return calls.map((call) =>
    safeCallResponse(call.id, call)
  );
}

/*
|--------------------------------------------------------------------------
| GET MY CALL REQUESTS
|--------------------------------------------------------------------------
|
| GET /api/calls/requests
|
| Returns requests belonging only to the authenticated host.
|
*/

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
      .map((document) =>
        safeCallResponse(
          document.id,
          document.data()
        )
      )
      .filter((call) => {
        if (call.endedAt) {
          return false;
        }

        if (!ACTIVE_REQUEST_STATUSES.has(call.status)) {
          return false;
        }

        // Active calls remain visible regardless of age.
        if (
          call.status === "active" ||
          call.startedAt
        ) {
          return true;
        }

        const createdMs = getTimestampMs(
          call.createdAt
        );

        // Keep records without timestamps visible for investigation.
        if (!createdMs) {
          return true;
        }

        // Hide old, unstarted requests from the dashboard.
        return (
          now - createdMs <= REQUEST_TIMEOUT_MS
        );
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

/*
|--------------------------------------------------------------------------
| GET MY CALL HISTORY
|--------------------------------------------------------------------------
|
| GET /api/calls/history
|
| Each customer session remains a separate history entry,
| even when several customers shared one group room.
|
*/

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
      calls: safeCallList(calls),
    });
  } catch (error) {
    return next(error);
  }
}

/*
|--------------------------------------------------------------------------
| ACCEPT CALL REQUEST
|--------------------------------------------------------------------------
|
| POST /api/calls/:callId/accept
|
| The existing call request is attached to the host's group room.
|
| This operation:
| - Does not create a duplicate call session.
| - Preserves the original call ID.
| - Checks customer balance.
| - Checks host availability and schedule.
| - Checks the host's group-room capacity.
| - Reuses the existing group room where possible.
| - Reserves the customer's activeCallId.
|
*/

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

    if (!validCallId(callId)) {
      return sendError(
        res,
        400,
        "A valid call ID is required."
      );
    }

    /*
     * The service performs the complete Firestore transaction.
     *
     * Do not change the call status separately here.
     * The service attaches the existing request and updates
     * the call, customer, host and group-room records together.
     */
    const result = await attachExistingCallToGroupRoom({
      callId,
      hostId,
    });

    res.setHeader("Cache-Control", "no-store");

    if (!result?.matched) {
      const message =
        result?.message ||
        "The call request could not be accepted.";

      return sendError(
        res,
        409,
        message,
        {
          retry: Boolean(result?.retry),
        }
      );
    }

    return res.status(200).json({
      success: true,

      message:
        result.message ||
        "Call accepted successfully.",

      alreadyAttached: Boolean(
        result.alreadyAttached
      ),

      call: safeCallResponse(
        result.call?.id || callId,
        result.call
      ),

      room: result.room
        ? {
            id: result.room.id,
            roomName: result.room.roomName,
            status: result.room.status,
            customerCount: result.room.customerCount,
            maxCustomers: result.room.maxCustomers,
            maxParticipants: result.room.maxParticipants,
          }
        : null,

      host: result.host
        ? {
            id: result.host.id,
            displayName: result.host.displayName,
            photoURL: result.host.photoURL,
          }
        : null,
    });
  } catch (error) {
    console.error("SA LIVE accept call request failed:", {
      message: error?.message || "Unknown error",
    });

    if (
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status < 600
    ) {
      return sendError(
        res,
        error.status,
        error.message
      );
    }

    return next(error);
  }
}
