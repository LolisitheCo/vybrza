
import {
  removeUserRecord,
  removeHostRecord,
} from "../services/adminManagementService.js";

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
