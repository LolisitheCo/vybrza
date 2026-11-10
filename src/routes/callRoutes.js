
import express from "express";

import {
  getMyCallRequests,
  getMyCallHistory,
  acceptCallRequest,
} from "../controllers/callController.js";

import {
  verifyFirebaseToken,
  requireHost,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// ============================================================
// SA LIVE — HOST CALL ROUTES
// Base path: /api/calls
//
// Group capacity:
// - 1 host
// - Maximum 5 customers
// - Maximum 6 participants total
//
// Each customer has an independent callSession.
// Customers only connect to the host they selected.
// ============================================================

// All routes require Firebase authentication and an
// active, authorized host account.
router.use(
  verifyFirebaseToken,
  requireHost
);

// ============================================================
// GET HOST CALL REQUESTS
// GET /api/calls/requests
// ============================================================

router.get(
  "/requests",
  getMyCallRequests
);

// ============================================================
// GET HOST CALL HISTORY
// GET /api/calls/history
// ============================================================

router.get(
  "/history",
  getMyCallHistory
);

// ============================================================
// ACCEPT CUSTOMER REQUEST
// POST /api/calls/:callId/accept
//
// The controller and groupRoomService are responsible for:
// - Checking that the request belongs to this host.
// - Checking customer balance.
// - Checking host availability.
// - Reusing an available group room.
// - Enforcing the five-customer limit.
// - Preventing duplicate acceptance.
// - Updating the existing call session.
// ============================================================

router.post(
  "/:callId/accept",
  acceptCallRequest
);

export default router;
