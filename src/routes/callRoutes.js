
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

// All call routes require an authenticated, active host.
router.use(verifyFirebaseToken);
router.use(requireHost);

// GET /api/calls/requests
router.get("/requests", getMyCallRequests);

// GET /api/calls/history
router.get("/history", getMyCallHistory);

// POST /api/calls/:callId/accept
router.post("/:callId/accept", acceptCallRequest);

export default router;
