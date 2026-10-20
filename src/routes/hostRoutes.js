
import express from "express";

import { heartbeat } from "../controllers/hostController.js";

import {
  verifyFirebaseToken,
  requireHost,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes below require an authenticated host.
router.use(verifyFirebaseToken);
router.use(requireHost);

// Host presence heartbeat.
router.post("/heartbeat", heartbeat);

export default router;