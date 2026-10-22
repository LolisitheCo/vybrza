
import express from "express";

import {
  heartbeat,
  getMyHostProfile,
  updateMyHostProfile,
  publicHostDirectory,
} from "../controllers/hostController.js";

import {
  verifyFirebaseToken,
  requireHost,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// Public directory: safe fields only, no host login required.
router.get("/public", publicHostDirectory);

// All remaining routes require an authenticated active host.
router.use(verifyFirebaseToken);
router.use(requireHost);

// Read and update the signed-in host's own profile.
router.get("/me", getMyHostProfile);
router.put("/me", updateMyHostProfile);

// Host presence heartbeat.
router.post("/heartbeat", heartbeat);

export default router;
