import express from "express";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  stitchWebhook,
} from "../controllers/paymentController.js";

import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";

const router = express.Router();

// Public Stitch webhook
router.post("/stitch/webhook", stitchWebhook);

// Public customer return URL
router.get("/callback", paymentCallback);

// Authenticated customer payment routes
router.post("/initialize", verifyFirebaseToken, initializePayment);

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

export default router;