
import { db } from "../config/firebase.js";
import { matchUserToHost } from "../services/matchingService.js";

const usersCollection = db.collection("users");
const callSessionsCollection = db.collection("callSessions");

const PENDING_STATUSES = new Set(["matching"]);
const ACTIVE_STATUSES = new Set(["matched", "active"]);

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
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
    durationSeconds: call.durationSeconds ?? 0,
    endReason: call.endReason ?? null,
  };
}

function getAuthenticatedUserId(req) {
  const userId = req.user?.uid;

  if (
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    return null;
  }

  return userId;
}

/**
 * POST /api/customer-calls/match
 *
 * Creates a pending call request and reserves the
 * customer's activeCallId.
 *
 * The matching service does not create a group room.
 * The host acceptance flow attaches the existing request.
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

    res.setHeader("Cache-Control", "no-store");

    if (!result?.matched) {
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
        result.call?.id
      ),
      host: result.host ?? null,
    });
  } catch (error) {
    if (
      error.message ===
      "You need available minutes before starting a call."
    ) {
      return sendError(res, 403, error.message);
    }

    if (
      error.message ===
      "You already have a call in progress. End it before starting another."
    ) {
      return sendError(res, 409, error.message);
    }

    if (error.message === "Customer account not found.") {
      return sendError(res, 404, error.message);
    }

    return next(error);
  }
}

/**
 * GET /api/customer-calls/current
 *
 * Returns the authenticated customer's current call request.
 * Does not expose another customer's call information.
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

    const userSnapshot = await usersCollection
      .doc(userId)
      .get();

    if (!userSnapshot.exists) {
      return sendError(
        res,
        404,
        "Customer account not found."
      );
    }

    const user = userSnapshot.data();

    res.setHeader("Cache-Control", "no-store");

    if (!user.activeCallId) {
      return res.status(200).json({
        success: true,
        call: null,
        message: "You do not have a current call request.",
      });
    }

    const callSnapshot = await callSessionsCollection
      .doc(user.activeCallId)
      .get();

    if (!callSnapshot.exists) {
      return res.status(200).json({
        success: true,
        call: null,
        message: "Your current call request was not found.",
      });
    }

    const call = callSnapshot.data();

    // Defence in depth: verify ownership before returning data.
    if (call.userId !== userId) {
      return sendError(
        res,
        403,
        "You are not allowed to access this call."
      );
    }

    if (
      !call.status ||
      ["completed", "ended", "cancelled", "canceled", "failed"]
        .includes(String(call.status).toLowerCase())
    ) {
      return res.status(200).json({
        success: true,
        call: null,
        message: "You do not have an active call request.",
      });
    }

    return res.status(200).json({
      success: true,
      call: safeCallResponse(
        call,
        callSnapshot.id
      ),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/customer-calls/cancel
 *
 * Cancels only a request that is still waiting for host
 * acceptance. Once accepted or started, cancellation must
 * go through the LiveKit call-ending flow instead.
 *
 * The call and customer reservation are updated atomically.
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

        if (!callId) {
          return {
            error: "no_current_call",
          };
        }

        const callRef = callSessionsCollection.doc(callId);
        const callSnapshot = await transaction.get(callRef);

        if (!callSnapshot.exists) {
          transaction.update(userRef, {
            activeCallId: null,
            updatedAt: new Date(),
          });

          return {
            error: "call_not_found",
          };
        }

        const call = callSnapshot.data();

        if (call.userId !== userId) {
          return {
            error: "not_owner",
          };
        }

        if (ACTIVE_STATUSES.has(call.status)) {
          return {
            error: "already_accepted",
          };
        }

        if (!PENDING_STATUSES.has(call.status)) {
          return {
            error: "not_cancellable",
          };
        }

        const now = new Date();

        transaction.update(callRef, {
          status: "cancelled",
          endedAt: now,
          updatedAt: now,
          endReason: "user_ended",
          durationSeconds: 0,
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

    res.setHeader("Cache-Control", "no-store");

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
        "You do not have a pending call request."
      );
    }

    if (result.error === "call_not_found") {
      return sendError(
        res,
        404,
        "The call request was not found. Your reservation has been cleared."
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

    if (result.error === "not_cancellable") {
      return sendError(
        res,
        409,
        "This call request can no longer be cancelled."
      );
    }

    return res.status(200).json({
      success: true,
      message: "Your call request has been cancelled.",
      callId: result.callId,
    });
  } catch (error) {
    return next(error);
  }
}
