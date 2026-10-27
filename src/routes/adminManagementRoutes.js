import express from "express";

import {
  verifyFirebaseToken,
  requireAdmin,
} from "../middleware/authMiddleware.js";

import {
  removeUser,
  removeHost,
  listPendingHostApplications,
  approveHostApplicationAdmin,
  rejectHostApplicationAdmin,
  syncApprovedHostApplicationAdmin,
} from "../controllers/adminManagementController.js";

const router = express.Router();

// All routes require Firebase authentication and an active admin.
router.use(verifyFirebaseToken);
router.use(requireAdmin);

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

// User management.
router.delete("/users/:id", removeUser);

// Host management.
router.delete("/hosts/:id", removeHost);

export default router;