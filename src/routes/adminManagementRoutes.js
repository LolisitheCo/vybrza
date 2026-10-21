
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

// Every endpoint requires a valid Firebase token and an active admin.
router.use(verifyFirebaseToken);
router.use(requireAdmin);

router.delete("/users/:id", removeUser);
router.delete("/hosts/:id", removeHost);

export default router;
