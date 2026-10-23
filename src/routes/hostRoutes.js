
import express from "express";

import {
  heartbeat,
  getMyHostProfile,
  updateMyHostProfile,
  publicHostDirectory,
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

router.get("/public", publicHostDirectory);

/*
|--------------------------------------------------------------------------
| AUTHENTICATED HOST ROUTES
|--------------------------------------------------------------------------
*/

router.use(verifyFirebaseToken);
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
