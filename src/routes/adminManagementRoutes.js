
import express from "express";

import {
  verifyFirebaseToken,
  requireAdmin,
} from "../middleware/authMiddleware.js";

import {
  removeUser,
  removeHost,
} from "../controllers/adminManagementController.js";

import {
  listAdminWithdrawals,
  payAdminWithdrawal,
  rejectAdminWithdrawal,
} from "../controllers/adminWithdrawalController.js";

const router = express.Router();

/*
|--------------------------------------------------------------------------
| ADMIN AUTHORIZATION
|--------------------------------------------------------------------------
*/

router.use(verifyFirebaseToken);
router.use(requireAdmin);

/*
|--------------------------------------------------------------------------
| USER AND HOST MANAGEMENT
|--------------------------------------------------------------------------
*/

router.delete("/users/:id", removeUser);
router.delete("/hosts/:id", removeHost);

/*
|--------------------------------------------------------------------------
| WITHDRAWAL MANAGEMENT
|--------------------------------------------------------------------------
*/

router.get("/withdrawals", listAdminWithdrawals);
router.post("/withdrawals/:id/paid", payAdminWithdrawal);
router.post("/withdrawals/:id/reject", rejectAdminWithdrawal);

export default router;
