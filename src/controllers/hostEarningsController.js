
import {
  getHostEarningsSummary,
  requestHostWithdrawal,
  getHostWithdrawalHistory,
} from "../services/hostEarningsService.js";

/*
|--------------------------------------------------------------------------
| GET HOST EARNINGS SUMMARY
|--------------------------------------------------------------------------
*/

export async function getMyEarnings(req, res) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Host account not found.",
      });
    }

    const summary = await getHostEarningsSummary(hostId);

    return res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Get host earnings error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load your earnings right now.",
    });
  }
}

/*
|--------------------------------------------------------------------------
| REQUEST HOST WITHDRAWAL
|--------------------------------------------------------------------------
*/

export async function createMyWithdrawal(req, res) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Host account not found.",
      });
    }

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

    return res.status(201).json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    console.error("Create host withdrawal error:", error);

    const clientErrors = [
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

    if (clientErrors.includes(error.message)) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to submit your withdrawal request.",
    });
  }
}

/*
|--------------------------------------------------------------------------
| GET HOST WITHDRAWAL HISTORY
|--------------------------------------------------------------------------
*/

export async function getMyWithdrawals(req, res) {
  try {
    const hostId = req.hostAccount?.id;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Host account not found.",
      });
    }

    const withdrawals = await getHostWithdrawalHistory(hostId);

    return res.json({
      success: true,
      data: withdrawals,
    });
  } catch (error) {
    console.error("Get host withdrawals error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load your withdrawal history.",
    });
  }
}
