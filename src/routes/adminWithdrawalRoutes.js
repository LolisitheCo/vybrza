
import express from "express";

import {
  listAdminWithdrawals,
  payAdminWithdrawal,
  rejectAdminWithdrawal,
} from "../controllers/adminWithdrawalController.js";

import {
  verifyFirebaseToken,
  requireAdmin,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes require an authenticated Firebase admin.
router.use(verifyFirebaseToken);
router.use(requireAdmin);

// GET /api/admin/withdrawals?status=pending
// Supported statuses: pending, paid, rejected, all
router.get("/", listAdminWithdrawals);

// POST /api/admin/withdrawals/:id/pay
// Record a manual bank transfer that has already been completed.
router.post("/:id/pay", payAdminWithdrawal);

// POST /api/admin/withdrawals/:id/reject
// Reject a request and return its reserved funds to the host.
router.post("/:id/reject", rejectAdminWithdrawal);

export default router;
