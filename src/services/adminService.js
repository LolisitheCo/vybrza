import {
  getPendingUsers,
  approveVerification,
  rejectVerification,
} from "./userService.js";

export async function getPendingVerificationUsers() {
  return getPendingUsers();
}

export async function approveUser(
  userId,
  adminTelegramId
) {
  return approveVerification(
    userId,
    adminTelegramId
  );
}

export async function rejectUser(
  userId,
  adminTelegramId
) {
  return rejectVerification(
    userId,
    adminTelegramId
  );
}