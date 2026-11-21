
import express from "express";
import { rateLimit } from "express-rate-limit";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  stitchWebhook,
} from "../controllers/paymentController.js";

import {
  verifyFirebaseToken,
  requireVerifiedEmail,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// ------------------------------------------------------------
// PAYMENT RATE LIMITERS
// ------------------------------------------------------------

const initializeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Please try again later.",
  },
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many checkout requests. Please wait.",
  },
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment verification requests.",
  },
});

// ------------------------------------------------------------
// PUBLIC STITCH WEBHOOK
// ------------------------------------------------------------

// Keep this public.
// Security is enforced by Svix signature verification
// inside the payment controller.

router.post(
  "/stitch/webhook",
  stitchWebhook
);

// ------------------------------------------------------------
// PUBLIC CUSTOMER RETURN URL
// ------------------------------------------------------------

router.get(
  "/callback",
  paymentCallback
);

// ------------------------------------------------------------
// AUTHENTICATED PAYMENT INITIALIZATION
// ------------------------------------------------------------

router.post(
  "/initialize",
  verifyFirebaseToken,
  requireVerifiedEmail,
  initializeLimiter,
  initializePayment
);

// ------------------------------------------------------------
// REUSE EXISTING PAYMENT CHECKOUT
// ------------------------------------------------------------

router.post(
  "/checkout/:reference",
  verifyFirebaseToken,
  requireVerifiedEmail,
  checkoutLimiter,
  initializeExistingPaymentCheckout
);

// ------------------------------------------------------------
// VERIFY PAYMENT
// ------------------------------------------------------------

router.get(
  "/verify/:reference",
  verifyFirebaseToken,
  requireVerifiedEmail,
  verifyLimiter,
  verifyPayment
);

export default router;
