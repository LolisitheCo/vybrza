
const {
  initializeApp,
  applicationDefault,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const PROJECT_ID = "thevibessa-bot";

async function main() {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const email = (
      await rl.question("Enter the exact SA LIVE Firebase account email: ")
    ).trim();

    if (!email) {
      throw new Error("Email is required.");
    }

    const confirmation = (
      await rl.question(
        `Type PROMOTE ADMIN to grant admin access to ${email}: `
      )
    ).trim();

    if (confirmation !== "PROMOTE ADMIN") {
      throw new Error("Cancelled. No role was changed.");
    }

    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });

    const auth = getAuth();

    console.log("Checking Firebase project:", PROJECT_ID);

    const user = await auth.getUserByEmail(email);

    if (!user.emailVerified) {
      throw new Error(
        "The account email is not verified. Verify it before proceeding."
      );
    }

    const existingClaims = user.customClaims || {};

    await auth.setCustomUserClaims(user.uid, {
      ...existingClaims,
      admin: true,
    });

    const updatedUser = await auth.getUser(user.uid);

    if (updatedUser.customClaims?.admin !== true) {
      throw new Error("The admin claim could not be verified.");
    }

    console.log("\nSUCCESS: Admin claim assigned.");
    console.log("Project:", PROJECT_ID);
    console.log("Email:", updatedUser.email);
    console.log("UID:", updatedUser.uid);
    console.log("Admin:", updatedUser.customClaims.admin);
    console.log("\nSign out of the website and sign in again.");
  } catch (error) {
    console.error("\nFAILED");
    console.error("Error code:", error.code || "unknown");
    console.error("Error message:", error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
