
import express from "express";

import {
  verifyFirebaseToken,
  requireAdmin,
} from "../middleware/authMiddleware.js";

import {
  removeUser,
  removeHost,
} from "../controllers/adminManagementController.js";

const router = express.Router();

// All admin management routes require Firebase authentication
// and an active admin account.
router.use(verifyFirebaseToken);
router.use(requireAdmin);

// User management.
router.delete("/users/:id", removeUser);

// Host management.
router.delete("/hosts/:id", removeHost);

export default router;
