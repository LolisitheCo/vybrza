
const {
  initializeApp,
  applicationDefault,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const PROJECT_ID = "thevibessa-bot";

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const email = (
      await rl.question("Firebase account email: ")
    ).trim();

    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });

    const user = await getAuth().getUserByEmail(email);

    console.log("\nProject:", PROJECT_ID);
    console.log("Email:", user.email);
    console.log("UID:", user.uid);
    console.log("Email verified:", user.emailVerified);

    console.log(
      "Admin claim:",
      user.customClaims?.admin === true
    );

    console.log(
      "Host claim:",
      user.customClaims?.host === true
    );

    console.log(
      "Role claim:",
      user.customClaims?.role ?? "(not set)"
    );

  } catch (error) {
    console.error("Check failed:", error.code || error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
