
import express from "express";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  stitchWebhook,
} from "../controllers/paymentController.js";

import {
  verifyFirebaseToken,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// Customer payment routes
router.post(
  "/initialize",
  verifyFirebaseToken,
  initializePayment
);

router.post(
  "/checkout/:reference",
  verifyFirebaseToken,
  initializeExistingPaymentCheckout
);

router.get(
  "/verify/:reference",
  verifyFirebaseToken,
  verifyPayment
);

// Stitch webhook — public endpoint.
// Signature verification happens inside stitchWebhook.
router.post(
  "/stitch/webhook",
  stitchWebhook
);

// Customer return page.
// This does not confirm or credit payments.
router.get(
  "/callback",
  paymentCallback
);

export default router;
