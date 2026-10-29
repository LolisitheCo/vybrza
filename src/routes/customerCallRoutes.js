
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

const router = express.Router();

// All customer call operations require authentication.
router.use(verifyFirebaseToken);

// All customer call operations require a verified email.
router.use(requireVerifiedEmail);

// Create a new customer call request.
router.post("/match", requestCustomerCall);

// Get the customer's current request or call.
router.get("/current", getCurrentCustomerCall);

// Cancel a request that has not yet been accepted.
router.post("/cancel", cancelCustomerCall);

export default router;
