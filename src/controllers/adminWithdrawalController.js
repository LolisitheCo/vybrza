
import {
  getAdminWithdrawals,
  markWithdrawalPaid,
  rejectWithdrawal,
} from "../services/adminWithdrawalService.js";

/*
|--------------------------------------------------------------------------
| LIST WITHDRAWALS
|--------------------------------------------------------------------------
*/

export async function listAdminWithdrawals(req, res) {
  try {
    const status = String(req.query.status ?? "pending");

    const withdrawals = await getAdminWithdrawals(status);

    return res.json({
      success: true,
      data: withdrawals,
    });
  } catch (error) {
    console.error("List admin withdrawals error:", error);

    if (error.message === "Invalid withdrawal status.") {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to load withdrawal requests.",
    });
  }
}

/*
|--------------------------------------------------------------------------
| MARK WITHDRAWAL AS PAID
|--------------------------------------------------------------------------
*/

export async function payAdminWithdrawal(req, res) {
  try {
    const adminUid = req.user?.uid;
    const withdrawalId = req.params.id;
    const payoutReference = req.body?.payoutReference ?? "";

    const result = await markWithdrawalPaid(
      withdrawalId,
      adminUid,
      payoutReference
    );

    return res.json({
      success: true,
      message: "Withdrawal marked as paid.",
      data: result,
    });
  } catch (error) {
    console.error("Mark withdrawal paid error:", error);

    const clientErrors = [
      "A withdrawal ID is required.",
      "An authenticated admin is required.",
      "The payout reference is too long.",
      "Withdrawal request not found.",
      "Only pending withdrawals can be marked as paid.",
      "The withdrawal amount is invalid.",
    ];

    if (clientErrors.includes(error.message)) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to mark the withdrawal as paid.",
    });
  }
}

/*
|--------------------------------------------------------------------------
| REJECT WITHDRAWAL
|--------------------------------------------------------------------------
*/

export async function rejectAdminWithdrawal(req, res) {
  try {
    const adminUid = req.user?.uid;
    const withdrawalId = req.params.id;
    const reason = req.body?.reason;

    const result = await rejectWithdrawal(
      withdrawalId,
      adminUid,
      reason
    );

    return res.json({
      success: true,
      message: "Withdrawal rejected and reserved funds returned.",
      data: result,
    });
  } catch (error) {
    console.error("Reject withdrawal error:", error);

    const clientErrors = [
      "A withdrawal ID is required.",
      "An authenticated admin is required.",
      "Enter a rejection reason between 3 and 500 characters.",
      "Withdrawal request not found.",
      "Only pending withdrawals can be rejected.",
      "The withdrawal has no associated host.",
      "The withdrawal amount is invalid.",
      "The host account was not found. The withdrawal remains pending.",
    ];

    if (clientErrors.includes(error.message)) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to reject the withdrawal.",
    });
  }
}
