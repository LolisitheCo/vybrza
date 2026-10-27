
import express from "express";

import {
  verifyFirebaseToken,
  requireAdmin,
} from "../middleware/authMiddleware.js";

import {
  removeUser,
  removeHost,
  listPendingVerifications,
  approveCustomerVerification,
  rejectCustomerVerification,
  listPendingHostApplications,
  approveHostApplicationAdmin,
  rejectHostApplicationAdmin,
  syncApprovedHostApplicationAdmin,
} from "../controllers/adminManagementController.js";

const router = express.Router();

// All routes require Firebase authentication and an active admin.
router.use(verifyFirebaseToken);
router.use(requireAdmin);

// Customer verification review.
router.get("/verifications", listPendingVerifications);
router.post(
  "/verifications/:id/approve",
  approveCustomerVerification
);
router.post(
  "/verifications/:id/reject",
  rejectCustomerVerification
);

// Host application review.
router.get(
  "/host-applications",
  listPendingHostApplications
);
router.post(
  "/host-applications/:id/approve",
  approveHostApplicationAdmin
);
router.post(
  "/host-applications/:id/reject",
  rejectHostApplicationAdmin
);

router.post(
  "/host-applications/:id/sync",
  syncApprovedHostApplicationAdmin
);


// Existing user management.
router.delete("/users/:id", removeUser);

// Existing host management.
router.delete("/hosts/:id", removeHost);

export default router;
