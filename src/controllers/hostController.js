// ============================================================
// SA LIVE — HOST CONTROLLER
// ============================================================

import {
  hostHeartbeat,
} from "../services/hostService.js";

// ============================================================
// HOST HEARTBEAT
// ============================================================
// Expected middleware order:
//   verifyFirebaseToken
//   requireHost
//   heartbeat
//
// Host identity comes exclusively from req.host,
// populated by trusted backend authorization middleware.
// ============================================================

export async function heartbeat(req, res) {
  try {
    const hostId = req.host?.id;

    if (
      typeof hostId !== "string" ||
      !hostId.trim()
    ) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const result = await hostHeartbeat(hostId);

    return res.status(200).json({
      success: true,
      message: "Host heartbeat received.",
      host: result,
    });
  } catch (error) {
    console.error(
      "Host heartbeat failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to update host presence. Please try again.",
    });
  }
}