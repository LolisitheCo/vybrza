
import {
  removeUserRecord,
  removeHostRecord,
} from "../services/adminManagementService.js";

import {
  getPendingUsers,
  approveVerification,
  rejectVerification,
} from "../services/userService.js";

import {
  getPendingHostApplications,
  approveHostApplication,
  rejectHostApplication,
} from "../services/hostApplicationService.js";

function handleError(res, error, action) {
  const status = Number(error?.status);

  if (status >= 400 && status < 500) {
    return res.status(status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(`Admin ${action} failed:`, error);

  return res.status(500).json({
    success: false,
    message: "The operation failed because of a server error.",
  });
}

function getAdminUid(req) {
  return typeof req.user?.uid === "string"
    ? req.user.uid.trim()
    : "";
}

/*
|--------------------------------------------------------------------------
| REMOVE USER
|--------------------------------------------------------------------------
*/

export async function removeUser(req, res) {
  try {
    const result = await removeUserRecord(req.params.id);

    return res.status(200).json({
      success: true,
      message: "User removed successfully.",
      result,
    });
  } catch (error) {
    return handleError(res, error, "user removal");
  }
}

/*
|--------------------------------------------------------------------------
| REMOVE HOST
|--------------------------------------------------------------------------
*/

export async function removeHost(req, res) {
  try {
    const result = await removeHostRecord(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Host removed successfully.",
      result,
    });
  } catch (error) {
    return handleError(res, error, "host removal");
  }
}

/*
|--------------------------------------------------------------------------
| GET PENDING CUSTOMER VERIFICATIONS
|--------------------------------------------------------------------------
*/

export async function listPendingVerifications(req, res) {
  try {
    const users = await getPendingUsers();

    return res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "loading pending customer verifications"
    );
  }
}

/*
|--------------------------------------------------------------------------
| APPROVE CUSTOMER VERIFICATION
|--------------------------------------------------------------------------
*/

export async function approveCustomerVerification(req, res) {
  const adminUid = getAdminUid(req);

  if (!adminUid) {
    return res.status(401).json({
      success: false,
      message: "Authenticated administrator required.",
    });
  }

  try {
    const result = await approveVerification(
      req.params.id,
      adminUid
    );

    return res.status(200).json({
      success: true,
      message: result.alreadyApproved
        ? "Customer verification was already approved."
        : "Customer verification approved successfully.",
      result,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "approving customer verification"
    );
  }
}

/*
|--------------------------------------------------------------------------
| REJECT CUSTOMER VERIFICATION
|--------------------------------------------------------------------------
*/

export async function rejectCustomerVerification(req, res) {
  const adminUid = getAdminUid(req);

  if (!adminUid) {
    return res.status(401).json({
      success: false,
      message: "Authenticated administrator required.",
    });
  }

  const reason = req.body?.reason;

  if (typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({
      success: false,
      message: "A rejection reason is required.",
    });
  }

  try {
    const result = await rejectVerification(
      req.params.id,
      adminUid,
      reason
    );

    return res.status(200).json({
      success: true,
      message: "Customer verification rejected.",
      result,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "rejecting customer verification"
    );
  }
}

/*
|--------------------------------------------------------------------------
| GET PENDING HOST APPLICATIONS
|--------------------------------------------------------------------------
*/

export async function listPendingHostApplications(req, res) {
  try {
    const applications = await getPendingHostApplications();

    return res.status(200).json({
      success: true,
      count: applications.length,
      applications,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "loading pending host applications"
    );
  }
}

/*
|--------------------------------------------------------------------------
| APPROVE HOST APPLICATION
|--------------------------------------------------------------------------
*/

export async function approveHostApplicationAdmin(req, res) {
  const adminUid = getAdminUid(req);

  if (!adminUid) {
    return res.status(401).json({
      success: false,
      message: "Authenticated administrator required.",
    });
  }

  try {
    const result = await approveHostApplication(
      req.params.id,
      adminUid
    );

    return res.status(200).json({
      success: true,
      message: result.alreadyApproved
        ? "Host application was already approved."
        : "Host application approved successfully.",
      result,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "approving host application"
    );
  }
}

/*
|--------------------------------------------------------------------------
| REJECT HOST APPLICATION
|--------------------------------------------------------------------------
*/

export async function rejectHostApplicationAdmin(req, res) {
  const adminUid = getAdminUid(req);

  if (!adminUid) {
    return res.status(401).json({
      success: false,
      message: "Authenticated administrator required.",
    });
  }

  const reason = req.body?.reason;

  if (typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({
      success: false,
      message: "A rejection reason is required.",
    });
  }

  try {
    const result = await rejectHostApplication(
      req.params.id,
      adminUid,
      reason
    );

    return res.status(200).json({
      success: true,
      message: "Host application rejected.",
      result,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "rejecting host application"
    );
  }
}
