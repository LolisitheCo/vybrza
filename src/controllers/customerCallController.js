
import { db } from "../config/firebase.js";
import { matchUserToHost } from "../services/matchingService.js";

// ============================================================
// SA LIVE — CUSTOMER CALL CONTROLLER
// ============================================================

const usersCollection = db.collection("users");
const callSessionsCollection = db.collection("callSessions");

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const PENDING_STATUS = "matching";

const TERMINAL_STATUSES = new Set([
  "completed",
  "ended",
  "cancelled",
  "canceled",
  "failed",
  "expired",
]);

// ============================================================
// HELPERS
// ============================================================

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function getAuthenticatedUserId(req) {
  const userId = req.user?.uid;

  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    return null;
  }

  return userId.trim();
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

function isExpiredRequest(call, now = Date.now()) {
  if (call.status !== PENDING_STATUS) {
    return false;
  }

  const createdAt = timestampMillis(call.createdAt);

  return (
    createdAt > 0 &&
    now - createdAt >= REQUEST_TIMEOUT_MS
  );
}

function isTerminalCall(call) {
  return (
    !call ||
    Boolean(call.endedAt) ||
    TERMINAL_STATUSES.has(
      String(call.status || "").toLowerCase()
    )
  );
}

function safeCallResponse(call, callId) {
  if (!call) return null;

  return {
    id: callId,

    status: call.status ?? null,

    hostId: call.hostId ?? null,

    groupRoomId: call.groupRoomId ?? null,

    roomId: call.roomId ?? null,

    roomUrl: call.roomUrl ?? null,

    createdAt: call.createdAt ?? null,

    updatedAt: call.updatedAt ?? null,

    startedAt: call.startedAt ?? null,

    endedAt: call.endedAt ?? null,

    durationSeconds: Number(call.durationSeconds) || 0,

    billableMinutes: Number(call.billableMinutes) || 0,

    endReason: call.endReason ?? null,
  };
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

// ============================================================
// CREATE CUSTOMER REQUEST
// ============================================================

/**
 * POST /api/customer-calls/match
 *
 * Creates a matching request.
 *
 * The customer remains in the waiting room until the host
 * accepts the request.
 */
export async function requestCustomerCall(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return sendError(
        res,
        401,
        "Authentication is required."
      );
    }

    const result = await matchUserToHost(userId);

    noStore(res);

    if (!result?.matched || !result.call?.id) {
      return res.status(409).json({
        success: false,

        message:
          result?.message ||
          "No available host was found. Please try again shortly.",

        retry: Boolean(result?.retry),
      });
    }

    return res.status(201).json({
      success: true,

      message: "Your call request has been created.",

      call: safeCallResponse(
        result.call,
        result.call.id
      ),

      host: result.host ?? null,
    });
  } catch (error) {
    if (error.status) {
      return sendError(
        res,
        error.status,
        error.message
      );
    }

    console.error(
      "[SA LIVE] Customer call request failed:",
      error
    );

    return next(error);
  }
}

// ============================================================
// GET CURRENT CUSTOMER REQUEST
// ============================================================

/**
 * GET /api/customer-calls/current
 *
 * Used by the waiting room to poll the request status.
 *
 * Only returns the authenticated customer's own call.
 */
export async function getCurrentCustomerCall(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return sendError(
        res,
        401,
        "Authentication is required."
      );
    }

    const userRef = usersCollection.doc(userId);

    const result = await db.runTransaction(
      async (transaction) => {
        const userSnapshot = await transaction.get(userRef);

        if (!userSnapshot.exists) {
          return {
            error: "customer_not_found",
          };
        }

        const user = userSnapshot.data();
        const callId = user.activeCallId;

        if (!callId || typeof callId !== "string") {
          return {
            call: null,
          };
        }

        const callRef = callSessionsCollection.doc(callId);
        const callSnapshot = await transaction.get(callRef);

        const now = new Date();

        // Clear a stale pointer if its call document is missing.
        if (!callSnapshot.exists) {
          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            call: null,
            cleaned: true,
          };
        }

        const call = callSnapshot.data();

        // Verify ownership before exposing any call information.
        if (
          call.userId !== userId &&
          call.customerUid !== userId
        ) {
          return {
            error: "not_owner",
          };
        }

        // Expire old waiting requests and release their reservation.
        if (isExpiredRequest(call, now.getTime())) {
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

          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            call: null,
            expired: true,
          };
        }

        // Clear reservations for terminal calls.
        if (isTerminalCall(call)) {
          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            call: null,
          };
        }

        return {
          call: safeCallResponse(call, callSnapshot.id),
        };
      }
    );

    noStore(res);

    if (result.error === "customer_not_found") {
      return sendError(
        res,
        404,
        "Customer account not found."
      );
    }

    if (result.error === "not_owner") {
      return sendError(
        res,
        403,
        "You are not allowed to access this call."
      );
    }

    return res.status(200).json({
      success: true,

      call: result.call ?? null,

      expired: Boolean(result.expired),

      message: result.expired
        ? "Your request expired because no host accepted in time."
        : result.call
          ? "Current call request retrieved."
          : "You do not have a current call request.",
    });
  } catch (error) {
    console.error(
      "[SA LIVE] Could not retrieve current customer call:",
      error
    );

    return next(error);
  }
}

// ============================================================
// CANCEL CUSTOMER WAITING REQUEST
// ============================================================

/**
 * POST /api/customer-calls/cancel
 *
 * Only a request in "matching" status can be cancelled here.
 *
 * Host acceptance changes matching -> matched in a Firestore
 * transaction. Cancellation changes matching -> cancelled
 * in a Firestore transaction.
 *
 * Because both transactions update the same call document,
 * only one operation can win.
 *
 * Accepted calls must be ended through the call-ending flow.
 */
export async function cancelCustomerCall(req, res, next) {
  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return sendError(
        res,
        401,
        "Authentication is required."
      );
    }

    const userRef = usersCollection.doc(userId);

    const result = await db.runTransaction(
      async (transaction) => {
        const userSnapshot = await transaction.get(userRef);

        if (!userSnapshot.exists) {
          return {
            error: "customer_not_found",
          };
        }

        const user = userSnapshot.data();
        const callId = user.activeCallId;

        if (!callId || typeof callId !== "string") {
          return {
            error: "no_current_call",
          };
        }

        const callRef = callSessionsCollection.doc(callId);
        const callSnapshot = await transaction.get(callRef);

        const now = new Date();

        // The call document disappeared. Release the stale pointer.
        if (!callSnapshot.exists) {
          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            error: "call_not_found",
          };
        }

        const call = callSnapshot.data();

        if (
          call.userId !== userId &&
          call.customerUid !== userId
        ) {
          return {
            error: "not_owner",
          };
        }

        // If another operation already ended it, clean the pointer.
        if (isTerminalCall(call)) {
          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            error: "already_ended",
          };
        }

        // A request older than ten minutes expires instead.
        if (isExpiredRequest(call, now.getTime())) {
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

          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: now,
          });

          return {
            error: "expired",
          };
        }

        // This is the important distinction:
        // matching is cancellable; matched and active are not.
        if (call.status !== PENDING_STATUS) {
          return {
            error: "already_accepted",
          };
        }

        transaction.update(callRef, {
          status: "cancelled",
          endedAt: now,
          updatedAt: now,
          endReason: "user_ended",
          durationSeconds: 0,
          minutesUsed: 0,
          billableMinutes: 0,
          billingStatus: "not_required",
        });

        transaction.update(userRef, {
          activeCallId: null,
          updatedAt: now,
        });

        return {
          cancelled: true,
          callId,
        };
      }
    );

    noStore(res);

    if (result.error === "customer_not_found") {
      return sendError(
        res,
        404,
        "Customer account not found."
      );
    }

    if (result.error === "no_current_call") {
      return sendError(
        res,
        404,
        "You do not have a current call request."
      );
    }

    if (result.error === "call_not_found") {
      return sendError(
        res,
        404,
        "The call request was missing. Your reservation has been cleared."
      );
    }

    if (result.error === "not_owner") {
      return sendError(
        res,
        403,
        "You are not allowed to cancel this call."
      );
    }

    if (result.error === "already_accepted") {
      return sendError(
        res,
        409,
        "Your host has already accepted. Use the call screen to leave the call."
      );
    }

    if (result.error === "already_ended") {
      return res.status(200).json({
        success: true,
        message: "This call has already ended.",
      });
    }

    if (result.error === "expired") {
      return res.status(200).json({
        success: true,
        expired: true,
        message: "Your request expired and your reservation was cleared.",
      });
    }

    if (result.cancelled) {
      return res.status(200).json({
        success: true,
        cancelled: true,
        message: "Your call request has been cancelled.",
        callId: result.callId,
      });
    }

    return sendError(
      res,
      409,
      "This call request could not be cancelled."
    );
  } catch (error) {
    console.error(
      "[SA LIVE] Customer call cancellation failed:",
      error
    );

    return next(error);
  }
}
