import "dotenv/config";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const ADMIN_EMAIL = process.env.SA_LIVE_ADMIN_EMAIL?.trim();

if (!ADMIN_EMAIL) {
  throw new Error(
    "Missing SA_LIVE_ADMIN_EMAIL in backend .env"
  );
}

initializeApp({
  credential: applicationDefault(),
});

async function setAdmin() {
  try {
    const user = await getAuth().getUserByEmail(ADMIN_EMAIL);

    await getAuth().setCustomUserClaims(user.uid, {
      ...(user.customClaims || {}),
      admin: true,
    });

    console.log("Admin role assigned successfully.");
    console.log("Admin UID:", user.uid);
    console.log("Sign out and sign in again to refresh your access token.");
  } catch (error) {
    console.error("Admin setup failed:", error.message);
    process.exitCode = 1;
  }
}

setAdmin();