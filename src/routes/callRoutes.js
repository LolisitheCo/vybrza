
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
| SA LIVE — HOST CALL REQUEST ROUTES
|--------------------------------------------------------------------------
|
| Base path:
| /api/calls
|
| Authentication:
| - Firebase authentication required.
| - Host account required.
| - Host must be authorized by requireHost middleware.
|
| Group call rules:
| - One host can have up to 3 customers.
| - Each customer has an independent callSession.
| - All customers accepted by the same host may share one group room.
| - The controller and groupRoomService enforce capacity and matching.
|
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
|
| Every route below requires a valid Firebase token and an authorized
| host account.
|
*/

router.use(verifyFirebaseToken);
router.use(requireHost);

/*
|--------------------------------------------------------------------------
| GET MY CALL REQUESTS
|--------------------------------------------------------------------------
|
| GET /api/calls/requests
|
| Returns call requests assigned to the authenticated host.
|
| The controller must return only requests belonging to this host.
|
*/

router.get(
  "/requests",
  getMyCallRequests
);

/*
|--------------------------------------------------------------------------
| GET MY CALL HISTORY
|--------------------------------------------------------------------------
|
| GET /api/calls/history
|
| Returns the authenticated host's call history.
|
| Group calls must remain separate customer sessions in the history.
|
*/

router.get(
  "/history",
  getMyCallHistory
);

/*
|--------------------------------------------------------------------------
| ACCEPT A CUSTOMER CALL REQUEST
|--------------------------------------------------------------------------
|
| POST /api/calls/:callId/accept
|
| The controller must:
| 1. Validate the call ID.
| 2. Confirm the request belongs to this host.
| 3. Confirm the host is eligible to accept calls.
| 4. Confirm the customer has sufficient balance.
| 5. Create or reuse the host's group room.
| 6. Enforce the maximum of 3 customers per host.
| 7. Prevent duplicate acceptance.
| 8. Return the accepted call and group-room details.
|
| Do not create a separate room for every customer when the host
| already has an available group room.
|
*/

router.post(
  "/:callId/accept",
  acceptCallRequest
);

export default router;
