
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
// PUBLIC ROUTES
// ============================================================

// Only sanitized, public host information may be returned.
router.get(
  "/public",
  publicDirectoryLimiter,
  publicHostDirectory
);

// ============================================================
// AUTHENTICATED WEBSITE-ACCOUNT ROUTES
// ============================================================

// Applicants do not need to be approved hosts.
router.use(verifyFirebaseToken);

router.post(
  "/applications",
  applicationLimiter,
  applyToBecomeHost
);

router.get(
  "/applications/me",
  getMyHostApplicationStatus
);

// ============================================================
// APPROVED HOST ROUTES
// ============================================================

router.use(requireHost);

// Profile
router.get("/me", getMyHostProfile);
router.put("/me", updateMyHostProfile);

// Presence
router.post(
  "/heartbeat",
  heartbeatLimiter,
  heartbeat
);

// Earnings
router.get("/earnings", getMyEarnings);

// Withdrawals
router.get("/withdrawals", getMyWithdrawals);

router.post(
  "/withdrawals",
  withdrawalLimiter,
  createMyWithdrawal
);

export default router;
