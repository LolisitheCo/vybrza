
import express from "express";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  stitchWebhook,
} from "../controllers/paymentController.js";

import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// ============================================================
// SA LIVE — STITCH PAY BY BANK PAYMENT ROUTES
// ============================================================

// Create a new payment and Stitch Pay By Bank checkout.
router.post(
  "/initialize",
  verifyFirebaseToken,
  initializePayment
);

// Re-create or retrieve checkout for an existing pending payment.
router.post(
  "/checkout/:reference",
  verifyFirebaseToken,
  initializeExistingPaymentCheckout
);

// Verify payment status using the backend and Stitch.
router.get(
  "/verify/:reference",
  verifyFirebaseToken,
  verifyPayment
);

// Stitch webhook.
// Public route: signature verification is handled inside the controller.
router.post(
  "/stitch/webhook",
  stitchWebhook
);

// Stitch return page.
// The browser redirect does NOT independently confirm payment.
router.get(
  "/callback",
  paymentCallback
);

export default router;
