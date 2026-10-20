
import {
  hostHeartbeat,
} from "../services/hostService.js";

export async function heartbeat(req, res) {
  try {
    // Use the host identity verified by the backend.
    // Never trust a hostId supplied by the browser.
    const result = await hostHeartbeat(req.host.id);

    return res.json({
      success: true,
      message: "Host heartbeat received.",
      host: result,
    });
  } catch (error) {
    console.error("Host heartbeat error:", error);

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Unable to update host presence.",
    });
  }
}