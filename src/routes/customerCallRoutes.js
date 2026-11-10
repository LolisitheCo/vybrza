
import express from "express";

import {
  verifyFirebaseToken,
  requireVerifiedEmail,
} from "../middleware/authMiddleware.js";

import {
  requestCustomerCall,
  getCurrentCustomerCall,
  cancelCustomerCall,
} from "../controllers/customerCallController.js";

import {
  syncEmailVerification,
} from "../controllers/emailVerificationController.js";

const router = express.Router();

// All routes require a valid Firebase login.
router.use(verifyFirebaseToken);

// IMPORTANT:
// Synchronisation must happen BEFORE requireVerifiedEmail.
router.post(
  "/me/sync-email-verification",
  syncEmailVerification
);

// All customer call operations require a verified email.
router.use(requireVerifiedEmail);

// Create a new customer call request.
router.post("/match", requestCustomerCall);

// Get the customer's current request or call.
router.get("/current", getCurrentCustomerCall);

// Cancel a request that has not yet been accepted.
router.post("/cancel", cancelCustomerCall);

export default router;
