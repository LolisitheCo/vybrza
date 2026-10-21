
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey } from "node:crypto";

import {
  getApps,
  initializeApp,
  cert,
} from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

/*
|--------------------------------------------------------------------------
| PATH CONFIGURATION
|--------------------------------------------------------------------------
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
|--------------------------------------------------------------------------
| VALIDATE FIREBASE SERVICE ACCOUNT
|--------------------------------------------------------------------------
*/

function validateServiceAccount(account) {
  if (
    !account ||
    typeof account !== "object" ||
    Array.isArray(account)
  ) {
    throw new Error(
      "Firebase service-account credentials must be a JSON object."
    );
  }

  const projectId = account.project_id;
  const clientEmail = account.client_email;

  if (
    typeof projectId !== "string" ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
  ) {
    throw new Error(
      "Firebase service-account project_id is missing or invalid."
    );
  }

  if (
    typeof clientEmail !== "string" ||
    clientEmail.length > 320 ||
    !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(
      clientEmail
    )
  ) {
    throw new Error(
      "Firebase service-account client_email is missing or invalid."
    );
  }

  if (
    typeof account.private_key !== "string" ||
    account.private_key.trim().length === 0
  ) {
    throw new Error(
      "Firebase service-account private_key is missing."
    );
  }

  // Environment variables often store newlines as the two characters \ and n.
  const normalizedPrivateKey = account.private_key
    .replace(/\\n/g, "\n")
    .trim();

  let privateKey;

  try {
    privateKey = createPrivateKey({
      key: normalizedPrivateKey,
      format: "pem",
    });
  } catch {
    throw new Error(
      "Firebase service-account private_key is not a valid private key."
    );
  }

  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(
      "Firebase service-account private_key must be an RSA key."
    );
  }

  const configuredProjectId =
    process.env.FIREBASE_PROJECT_ID?.trim();

  if (
    configuredProjectId &&
    configuredProjectId !== projectId
  ) {
    throw new Error(
      "FIREBASE_PROJECT_ID does not match the service-account project_id."
    );
  }

  return {
    ...account,
    project_id: projectId,
    client_email: clientEmail,
    private_key: normalizedPrivateKey,
  };
}

/*
|--------------------------------------------------------------------------
| LOAD SERVICE-ACCOUNT CREDENTIALS
|--------------------------------------------------------------------------
| Supported sources, in priority order:
| 1. FIREBASE_SERVICE_ACCOUNT_JSON
| 2. FIREBASE_SERVICE_ACCOUNT_PATH
| 3. Local fallback file for development
|
| Never log or return the credential contents.
|--------------------------------------------------------------------------
*/

function loadServiceAccount() {
  const credentialsJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (
    typeof credentialsJson === "string" &&
    credentialsJson.trim().length > 0
  ) {
    let account;

    try {
      account = JSON.parse(credentialsJson);
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON."
      );
    }

    return validateServiceAccount(account);
  }

  const configuredPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();

  const serviceAccountPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(
        __dirname,
        "../../firebase-service-account.json"
      );

  let contents;

  try {
    contents = fs.readFileSync(serviceAccountPath, "utf8");
  } catch {
    throw new Error(
      "Firebase credentials could not be loaded. Configure " +
      "FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH."
    );
  }

  let account;

  try {
    account = JSON.parse(contents);
  } catch {
    throw new Error(
      "The configured Firebase service-account file contains invalid JSON."
    );
  }

  return validateServiceAccount(account);
}

/*
|--------------------------------------------------------------------------
| STORAGE BUCKET VALIDATION
|--------------------------------------------------------------------------
*/

function getConfiguredStorageBucket() {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();

  if (!bucket) {
    return undefined;
  }

  // Accept a bucket hostname, not a URL or path.
  if (
    bucket.length > 255 ||
    bucket.includes("://") ||
    bucket.includes("/") ||
    /\s/.test(bucket)
  ) {
    throw new Error(
      "FIREBASE_STORAGE_BUCKET must be a bucket name or hostname, not a URL."
    );
  }

  return bucket;
}

/*
|--------------------------------------------------------------------------
| INITIALIZE FIREBASE ADMIN
|--------------------------------------------------------------------------
*/

const serviceAccount = loadServiceAccount();
const storageBucket = getConfiguredStorageBucket();

const existingDefaultApp = getApps().find(
  (app) => app.name === "[DEFAULT]"
);

let firebaseApp;

if (existingDefaultApp) {
  const existingProjectId =
    existingDefaultApp.options.projectId;

  if (
    existingProjectId &&
    existingProjectId !== serviceAccount.project_id
  ) {
    throw new Error(
      "The existing Firebase Admin app uses a different project."
    );
  }

  firebaseApp = existingDefaultApp;
} else {
  firebaseApp = initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id,
    ...(storageBucket
      ? { storageBucket }
      : {}),
  });
}

/*
|--------------------------------------------------------------------------
| FIRESTORE AND STORAGE CLIENTS
|--------------------------------------------------------------------------
*/

const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
| Preserve these exports for existing project imports.
|--------------------------------------------------------------------------
*/

export {
  firebaseApp,
  db,
  storage,
};
