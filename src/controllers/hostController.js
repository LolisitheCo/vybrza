
import {
  hostHeartbeat,
} from "../services/hostService.js";

import {
  getHostAvailabilityProfile,
  updateHostAvailabilityProfile,
  getPublicHostDirectory,
} from "../services/hostAvailabilityService.js";

export async function heartbeat(req, res) {
  try {
    const hostId = req.host?.id;

    if (!hostId) {
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
      message: "Unable to update host presence.",
    });
  }
}

export async function getMyHostProfile(req, res) {
  try {
    const hostId = req.host?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const profile = await getHostAvailabilityProfile(hostId);

    return res.status(200).json({
      success: true,
      host: profile,
    });
  } catch (error) {
    console.error(
      "Host profile lookup failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load your host profile.",
    });
  }
}

export async function updateMyHostProfile(req, res) {
  try {
    const hostId = req.host?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated host account required.",
      });
    }

    const profile = await updateHostAvailabilityProfile(
      hostId,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Host availability saved.",
      host: profile,
    });
  } catch (error) {
    const message = error?.message || "";

    const validationErrorMessages = [
      "Enter a public username.",
      "Username must be 3–32 characters and contain only letters, numbers, or underscores.",
      "Invalid availability schedule.",
      "Invalid availability entry.",
      "Choose a valid day.",
      "Each time slot must have a valid start and end time on the same day.",
      "Choose whether you want to accept calls.",
      "Invalid profile details.",
    ];

    if (validationErrorMessages.includes(message)) {
      return res.status(400).json({
        success: false,
        message,
      });
    }

    if (
      message === "Host account not found." ||
      message === "An active, linked host account is required."
    ) {
      return res.status(403).json({
        success: false,
        message,
      });
    }

    console.error(
      "Host profile update failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to save your host availability.",
    });
  }
}

export async function publicHostDirectory(req, res) {
  try {
    const hosts = await getPublicHostDirectory();

    return res.status(200).json({
      success: true,
      hosts,
    });
  } catch (error) {
    console.error(
      "Public host directory failed:",
      error?.code || "UNKNOWN_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load hosts right now.",
    });
  }
}
