
import {
  getHostEarningsSummary,
  requestHostWithdrawal,
  getHostWithdrawalHistory,
} from "../services/hostEarningsService.js";

function sendError(res, error, fallbackMessage, clientErrors = []) {
  if (clientErrors.includes(error.message)) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  if (error.status === 404) {
    return res.status(404).json({
      success: false,
      message: error.message || "Resource not found.",
    });
  }

  if (error.status === 409) {
    return res.status(409).json({
      success: false,
      message: error.message || "This request conflicts with the current state.",
    });
  }

  console.error(fallbackMessage, error.message || "Unknown error");

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

function getHostId(req, res) {
  const hostId = req.hostAccount?.id;

  if (typeof hostId !== "string" || !hostId.trim()) {
    res.status(401).json({
      success: false,
      message: "Authenticated host account required.",
    });

    return null;
  }

  return hostId;
}

const withdrawalClientErrors = [
  "A host ID is required.",
  "Please confirm that your bank details are correct.",
  "Enter a valid withdrawal amount.",
  "Enter a valid amount in rand and cents.",
  "Bank details are required.",
  "Enter a valid account holder name.",
  "Enter a valid bank name.",
  "Enter a valid account number.",
  "Choose savings, current, cheque, or transmission as the account type.",
  "The branch code is too long.",
  "Host account not found.",
  "Only active hosts can request withdrawals.",
  "Your withdrawal amount exceeds your available earnings.",
];

export async function getMyEarnings(req, res) {
  const hostId = getHostId(req, res);
  if (!hostId) return;

  try {
    const summary = await getHostEarningsSummary(hostId);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your earnings right now."
    );
  }
}

export async function createMyWithdrawal(req, res) {
  const hostId = getHostId(req, res);
  if (!hostId) return;

  try {
    const {
      amount,
      bankDetails,
      confirmedCorrect,
    } = req.body ?? {};

    const result = await requestHostWithdrawal(
      hostId,
      amount,
      bankDetails,
      confirmedCorrect
    );

    res.setHeader("Cache-Control", "no-store");

    return res.status(201).json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to submit your withdrawal request.",
      withdrawalClientErrors
    );
  }
}

export async function getMyWithdrawals(req, res) {
  const hostId = getHostId(req, res);
  if (!hostId) return;

  try {
    const withdrawals = await getHostWithdrawalHistory(hostId);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      data: withdrawals,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your withdrawal history."
    );
  }
}
