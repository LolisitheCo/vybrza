
import {
  getHostEarningsSummary,
  requestHostWithdrawal,
  getHostWithdrawalHistory,
} from "../services/hostEarningsService.js";

// ============================================================
// SA LIVE — HOST EARNINGS CONTROLLER
// ============================================================

const WITHDRAWAL_CLIENT_ERRORS = new Set([
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
]);

// ============================================================
// HELPERS
// ============================================================

function noStore(res) {
  res.set("Cache-Control", "no-store, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function getHostId(req, res) {
  const hostId = req.hostAccount?.id;

  if (
    typeof hostId !== "string" ||
    !hostId.trim()
  ) {
    res.status(401).json({
      success: false,
      message: "Authenticated host account required.",
    });

    return null;
  }

  return hostId.trim();
}

function sendError(
  res,
  error,
  fallbackMessage,
  clientErrors = new Set()
) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : "";

  if (clientErrors.has(message)) {
    return res.status(400).json({
      success: false,
      message,
    });
  }

  const status = Number(error?.status);

  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  ) {
    return res.status(status).json({
      success: false,
      message: message || fallbackMessage,
    });
  }

  console.error("[SA LIVE HOST EARNINGS]", {
    operation: fallbackMessage,
    code: error?.code || "UNKNOWN_ERROR",
    message: message || "No error message",
  });

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

// ============================================================
// GET MY EARNINGS
// ============================================================

export async function getMyEarnings(req, res) {
  noStore(res);

  const hostId = getHostId(req, res);

  if (!hostId) return;

  try {
    const summary = await getHostEarningsSummary(hostId);

    if (!summary) {
      return res.status(200).json({
        success: true,
        data: {
          availableBalance: 0,
          pendingBalance: 0,
          totalEarned: 0,
          totalWithdrawn: 0,
        },
      });
    }

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

// ============================================================
// CREATE WITHDRAWAL REQUEST
// ============================================================

export async function createMyWithdrawal(req, res) {
  noStore(res);

  const hostId = getHostId(req, res);

  if (!hostId) return;

  if (!isPlainObject(req.body)) {
    return res.status(400).json({
      success: false,
      message: "Invalid withdrawal request.",
    });
  }

  const {
    amount,
    bankDetails,
    confirmedCorrect,
  } = req.body;

  // The confirmation must be explicitly true.
  if (confirmedCorrect !== true) {
    return res.status(400).json({
      success: false,
      message: "Please confirm that your bank details are correct.",
    });
  }

  if (!isPlainObject(bankDetails)) {
    return res.status(400).json({
      success: false,
      message: "Bank details are required.",
    });
  }

  // Do not silently convert strings, arrays or malformed amounts.
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid withdrawal amount.",
    });
  }

  try {
    const result = await requestHostWithdrawal(
      hostId,
      amount,
      bankDetails,
      confirmedCorrect
    );

    return res.status(201).json({
      success: true,
      message:
        typeof result?.message === "string"
          ? result.message
          : "Withdrawal request submitted successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to submit your withdrawal request.",
      WITHDRAWAL_CLIENT_ERRORS
    );
  }
}

// ============================================================
// GET MY WITHDRAWAL HISTORY
// ============================================================

export async function getMyWithdrawals(req, res) {
  noStore(res);

  const hostId = getHostId(req, res);

  if (!hostId) return;

  try {
    const withdrawals = await getHostWithdrawalHistory(hostId);

    return res.status(200).json({
      success: true,
      data: Array.isArray(withdrawals)
        ? withdrawals
        : [],
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load your withdrawal history."
    );
  }
}
