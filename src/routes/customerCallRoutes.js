
import express from "express";

import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { matchUserToHost } from "../services/matchingService.js";

const router = express.Router();

// Every customer call request requires Firebase authentication.
router.use(verifyFirebaseToken);

/*
 * POST /api/customer-calls/match
 *
 * Matches the authenticated customer with an available host.
 * The customer's UID comes from the verified Firebase token,
 * never from a UID supplied in the request body.
 */
router.post("/match", async (req, res, next) => {
  try {
    const userId = req.user.uid;

    const result = await matchUserToHost(userId);

    res.setHeader("Cache-Control", "no-store");

    if (!result?.matched) {
      return res.status(409).json({
        success: false,
        message:
          result?.message ||
          "No available host was found. Please try again shortly.",
        retry: Boolean(result?.retry),
      });
    }

    return res.status(200).json({
      success: true,
      message: "A host has been matched.",
      call: result.call,
      host: result.host,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
