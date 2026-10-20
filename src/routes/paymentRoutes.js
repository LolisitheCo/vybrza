import express from "express";

import {
  initializePayment,
  verifyPayment,
  paymentCallback,
  paymentITN,
} from "../controllers/paymentController.js";

const router = express.Router();

router.post("/initialize", initializePayment);

router.get("/verify/:reference", verifyPayment);

router.get("/callback", paymentCallback);

// PayFast Instant Transaction Notification
router.post(
  "/itn",
  express.urlencoded({ extended: false }),
  paymentITN
);

export default router;