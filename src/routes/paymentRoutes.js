
import express from "express";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  paymentITN,
} from "../controllers/paymentController.js";

const router = express.Router();

// Initialize a new payment for authenticated clients.
router.post("/initialize", initializePayment);

// Prepare PayFast checkout for the existing Telegram payment.
router.post("/checkout/:reference", initializeExistingPaymentCheckout);

// Check a payment belonging to the authenticated user.
router.get("/verify/:reference", verifyPayment);

// Customer's browser return page.
// This endpoint must never credit minutes by itself.
router.get("/callback", paymentCallback);

// PayFast server-to-server Instant Transaction Notification.
router.post(
  "/itn",
  express.urlencoded({
    extended: false,
    limit: "20kb",
    parameterLimit: 100,
  }),
  paymentITN
);

export default router;
