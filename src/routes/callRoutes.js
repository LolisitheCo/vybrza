
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

/*
|--------------------------------------------------------------------------
| HOST AUTHENTICATION
|--------------------------------------------------------------------------
| Every route in this router requires:
| 1. A valid Firebase ID token.
| 2. An active host record linked to that Firebase account.
|--------------------------------------------------------------------------
*/

router.use(verifyFirebaseToken);
router.use(requireHost);

/*
|--------------------------------------------------------------------------
| HOST CALL REQUESTS
|--------------------------------------------------------------------------
| GET /api/calls/requests
*/

router.get("/requests", getMyCallRequests);

/*
|--------------------------------------------------------------------------
| HOST CALL HISTORY
|--------------------------------------------------------------------------
| GET /api/calls/history
*/

router.get("/history", getMyCallHistory);

/*
|--------------------------------------------------------------------------
| ACCEPT ASSIGNED CALL
|--------------------------------------------------------------------------
| POST /api/calls/:callId/accept
*/

router.post("/:callId/accept", acceptCallRequest);

export default router;
