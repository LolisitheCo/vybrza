
import { db } from "../config/firebase.js";

import {
  getHostCallHistory,
} from "../services/callService.js";

import {
  attachExistingCallToGroupRoom,
} from "../services/groupRoomService.js";

// ============================================================
// SA LIVE — HOST CALL CONTROLLER
// ============================================================

const callSessions = db.collection("callSessions");
const users = db.collection("users");

const ACTIVE_REQUEST_STATUSES = new Set([
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

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CALL_ID_LENGTH = 128;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ============================================================
// RESPONSE HELPERS
// ============================================================

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

function isTerminal(call) {
  return (
    !call ||
    Boolean(call.endedAt) ||
    TERMINAL_STATUSES.has(
      String(call.status || "").toLowerCase()
    )
  );
}

function isExpiredPendingRequest(call, now = Date.now()) {
  if (!call || call.status !== "matching") {
    return false;
  }

  const createdAt = getTimestampMs(call.createdAt);

  // Do not expire records with missing timestamps automatically.
  if (!createdAt) {
    return false;
  }

  return now - createdAt >= REQUEST_TIMEOUT_MS;
}

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

function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

// ============================================================
// EXPIRE ONE PENDING REQUEST
// ============================================================

/**
 * Expires an unaccepted matching request.
 *
 * This is transactional so a simultaneous host acceptance
 * cannot also successfully attach the same request.
 */
async function expirePendingRequest(callId, expectedHostId) {
  const callRef = callSessions.doc(callId);

  return db.runTransaction(async (transaction) => {
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      return false;
    }

    const call = callSnapshot.data();

    if (call.hostId !== expectedHostId) {
      return false;
    }

    if (!isExpiredPendingRequest(call)) {
      return false;
    }

    const userId = call.userId || call.customerUid;

    let userRef = null;
    let userSnapshot = null;

    if (
      typeof userId === "string" &&
      userId.trim()
    ) {
      userRef = users.doc(userId);
      userSnapshot = await transaction.get(userRef);
    }

    const now = new Date();

    transaction.update(callRef, {
      status: "expired",
      endedAt: now,
      updatedAt: now,
      endReason: "request_timeout",
      durationSeconds: 0,
      minutesUsed: 0,
      billableMinutes: 0,
      billingStatus: "not_required",
    });

    if (
      userRef &&
      userSnapshot?.exists &&
      userSnapshot.data().activeCallId === callId
    ) {
      transaction.update(userRef, {
        activeCallId: null,
        updatedAt: now,
      });
    }

    return true;
  });
}

// ============================================================
// GET MY CALL REQUESTS
// ============================================================

/**
 * GET /api/calls/requests
 *
 * Returns requests assigned to the authenticated host.
 * Old matching requests are expired and cleaned up first.
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

    const initialSnapshot = await callSessions
      .where("hostId", "==", hostId)
      .get();

    // Expire old pending requests before building the response.
    for (const document of initialSnapshot.docs) {
      const call = document.data();

      if (isExpiredPendingRequest(call)) {
        try {
          await expirePendingRequest(document.id, hostId);
        } catch (error) {
          console.error(
            "[SA LIVE] Could not expire pending request:",
            document.id,
            error.message
          );
        }
      }
    }

    // Refetch because the expiry transactions may have changed status.
    const refreshedSnapshot = await callSessions
      .where("hostId", "==", hostId)
      .get();

    const calls = refreshedSnapshot.docs
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

        if (isTerminal(call)) {
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

        // Only show unaccepted requests that have not expired.
        if (call.status === "matching") {
          const createdMs = getTimestampMs(call.createdAt);

          return (
            createdMs > 0 &&
            Date.now() - createdMs < REQUEST_TIMEOUT_MS
          );
        }

        // Matched calls remain visible while the call is being joined.
        return call.status === "matched";
      })
      .sort((a, b) => {
        return (
          getTimestampMs(b.createdAt) -
          getTimestampMs(a.createdAt)
        );
      });

    noStore(res);

    return res.status(200).json({
      success: true,
      calls,
    });
  } catch (error) {
    console.error(
      "[SA LIVE] Host call request retrieval failed:",
      error
    );

    return next(error);
  }
}

// ============================================================
// GET MY CALL HISTORY
// ============================================================

/**
 * GET /api/calls/history
 *
 * Each customer's call remains a separate history entry,
 * even when multiple customers shared a group room.
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

    noStore(res);

    return res.status(200).json({
      success: true,
      calls: safeCallList(calls),
    });
  } catch (error) {
    console.error(
      "[SA LIVE] Host call history retrieval failed:",
      error
    );

    return next(error);
  }
}

// ============================================================
// ACCEPT CALL REQUEST
// ============================================================

/**
 * POST /api/calls/:callId/accept
 *
 * The groupRoomService performs the transaction that:
 * - Confirms this request belongs to the host.
 * - Confirms the request is still matching.
 * - Rechecks customer balance.
 * - Rechecks host availability.
 * - Rechecks room capacity.
 * - Attaches the existing request to the group room.
 * - Changes matching -> matched.
 * - Reserves the customer.
 *
 * Host acceptance and customer cancellation both update the
 * same call document transactionally. Only one should succeed.
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

    const result = await attachExistingCallToGroupRoom({
      callId,
      hostId,
    });

    noStore(res);

    if (!result?.matched) {
      return sendError(
        res,
        409,
        result?.message ||
          "The call request could not be accepted.",
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

      alreadyAttached: Boolean(result.alreadyAttached),

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
    console.error(
      "[SA LIVE] Accept call request failed:",
      error?.message || error
    );

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
