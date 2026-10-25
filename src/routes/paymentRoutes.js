
import express from "express";

import {
  initializePayment,
  initializeExistingPaymentCheckout,
  verifyPayment,
  paymentCallback,
  paymentITN,
} from "../controllers/paymentController.js";

import {
  verifyFirebaseToken,
} from "../middleware/authMiddleware.js";

const router = express.Router();

/*
|--------------------------------------------------------------------------
| AUTHENTICATED WEBSITE PAYMENT ROUTES
|--------------------------------------------------------------------------
| The user's identity comes from a verified Firebase ID token.
| Never trust a user ID supplied by the browser.
|--------------------------------------------------------------------------
*/

// POST /api/payments/initialize
router.post(
  "/initialize",
  verifyFirebaseToken,
  initializePayment
);

// POST /api/payments/checkout/:reference
router.post(
  "/checkout/:reference",
  verifyFirebaseToken,
  initializeExistingPaymentCheckout
);

// GET /api/payments/verify/:reference
router.get(
  "/verify/:reference",
  verifyFirebaseToken,
  verifyPayment
);

/*
|--------------------------------------------------------------------------
| PUBLIC PAYFAST ROUTES
|--------------------------------------------------------------------------
| PayFast must be able to reach these endpoints without a user's
| Firebase session. The controller validates payment notifications.
|--------------------------------------------------------------------------
*/

// GET /api/payments/callback
// Browser redirect only. Never credits minutes by itself.
router.get("/callback", paymentCallback);

// POST /api/payments/itn
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
