
import {
  getAdminWithdrawals,
  markWithdrawalPaid,
  rejectWithdrawal,
} from "../services/adminWithdrawalService.js";

function sendError(res, error, fallbackMessage) {
  const status = Number(error?.status);

  if ([400, 401, 404, 409].includes(status)) {
    return res.status(status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(fallbackMessage, error?.message ?? "Unknown error");

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

export async function listAdminWithdrawals(req, res) {
  try {
    const status = String(req.query.status ?? "pending");
    const withdrawals = await getAdminWithdrawals(status);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      data: withdrawals,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load withdrawal requests."
    );
  }
}

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

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Withdrawal marked as paid.",
      data: result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to mark the withdrawal as paid."
    );
  }
}

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

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Withdrawal rejected and reserved funds returned.",
      data: result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to reject the withdrawal."
    );
  }
}
