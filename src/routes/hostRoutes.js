
import express from "express";
import { rateLimit } from "express-rate-limit";

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
  getMyEarningsDiagnostic,
} from "../controllers/hostEarningsController.js";

import {
  verifyFirebaseToken,
  requireHost,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// ============================================================
// RATE LIMITERS
// ============================================================

const publicDirectoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many directory requests. Please try again shortly.",
  },
});

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many application attempts. Please try again later.",
  },
});

const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Heartbeat rate limit reached.",
  },
});

const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many withdrawal requests. Please try again later.",
  },
});

// ============================================================
// PUBLIC HOST DIRECTORY
// No authentication required.
// ============================================================

router.get(
  "/public",
  publicDirectoryLimiter,
  publicHostDirectory
);

// ============================================================
// HOST APPLICATIONS
// Firebase authentication required.
// Host approval is NOT required.
// ============================================================

router.post(
  "/applications",
  verifyFirebaseToken,
  applicationLimiter,
  applyToBecomeHost
);

router.get(
  "/applications/me",
  verifyFirebaseToken,
  getMyHostApplicationStatus
);

// ============================================================
// APPROVED HOST PROFILE
// Firebase authentication + approved host required.
// ============================================================

router.get(
  "/me",
  verifyFirebaseToken,
  requireHost,
  getMyHostProfile
);

router.put(
  "/me",
  verifyFirebaseToken,
  requireHost,
  updateMyHostProfile
);

// ============================================================
// HOST HEARTBEAT
// Firebase authentication + approved host required.
// ============================================================

router.post(
  "/heartbeat",
  verifyFirebaseToken,
  requireHost,
  heartbeatLimiter,
  heartbeat
);

// ============================================================
// HOST EARNINGS
// Firebase authentication + approved host required.
// ============================================================

router.get(
  "/earnings",
  verifyFirebaseToken,
  requireHost,
  getMyEarnings
);

router.get(
  "/earnings/diagnostic",
  verifyFirebaseToken,
  requireHost,
  getMyEarningsDiagnostic
);

// ============================================================
// HOST WITHDRAWALS
// Firebase authentication + approved host required.
// ============================================================

router.get(
  "/withdrawals",
  verifyFirebaseToken,
  requireHost,
  getMyWithdrawals
);

router.post(
  "/withdrawals",
  verifyFirebaseToken,
  requireHost,
  withdrawalLimiter,
  createMyWithdrawal
);

export default router;
