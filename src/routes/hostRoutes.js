
import express from "express";

import {
  heartbeat,
  getMyHostProfile,
  updateMyHostProfile,
  publicHostDirectory,
  applyToBecomeHost,
  getMyHostApplicationStatus,
} from "../controllers/hostController.js";

import {
  getMyEarnings,
  createMyWithdrawal,
  getMyWithdrawals,
} from "../controllers/hostEarningsController.js";

import {
  verifyFirebaseToken,
  requireHost,
} from "../middleware/authMiddleware.js";

const router = express.Router();

/*
|--------------------------------------------------------------------------
| PUBLIC ROUTES
|--------------------------------------------------------------------------
*/

// Public directory returns sanitized host information only.
router.get("/public", publicHostDirectory);

/*
|--------------------------------------------------------------------------
| WEBSITE-ACCOUNT ROUTES
|--------------------------------------------------------------------------
| A signed-in user may apply to become a host before being approved.
| These routes must NOT require the host role.
|--------------------------------------------------------------------------
*/

router.use(verifyFirebaseToken);

router.post("/applications", applyToBecomeHost);
router.get("/applications/me", getMyHostApplicationStatus);

/*
|--------------------------------------------------------------------------
| APPROVED HOST ROUTES
|--------------------------------------------------------------------------
| Everything below requires a valid Firebase session and an active
| host record linked to the authenticated Firebase UID.
|--------------------------------------------------------------------------
*/

router.use(requireHost);

// Host profile and availability
router.get("/me", getMyHostProfile);
router.put("/me", updateMyHostProfile);
router.post("/heartbeat", heartbeat);

// Earnings
router.get("/earnings", getMyEarnings);

// Withdrawals
router.get("/withdrawals", getMyWithdrawals);
router.post("/withdrawals", createMyWithdrawal);

export default router;
