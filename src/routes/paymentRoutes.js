
import express from "express";

import {
  initializePayment,
  verifyPayment,
  paymentCallback,
  paymentITN,
} from "../controllers/paymentController.js";

const router = express.Router();

// Initialize a live PayFast checkout.
router.post("/initialize", initializePayment);

// Check a payment belonging to the authenticated user.
router.get("/verify/:reference", verifyPayment);

// Customer's browser return page.
// This endpoint must never credit minutes by itself.
router.get("/callback", paymentCallback);

// PayFast server-to-server Instant Transaction Notification.
// PayFast sends application/x-www-form-urlencoded data.
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
