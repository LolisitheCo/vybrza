
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getApps,
  initializeApp,
  cert,
} from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadServiceAccount() {
  // Option 1: JSON credentials stored as a Render environment variable.
  const credentialsJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (credentialsJson) {
    try {
      return JSON.parse(credentialsJson);
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."
      );
    }
  }

  // Option 2: Local service-account file for development.
  const configuredPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  const serviceAccountPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(
        __dirname,
        "../../firebase-service-account.json"
      );

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      "Firebase credentials are missing. Configure " +
      "FIREBASE_SERVICE_ACCOUNT_JSON in Render or provide " +
      "firebase-service-account.json locally."
    );
  }

  return JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8")
  );
}

const serviceAccount = loadServiceAccount();

const firebaseApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount),
        ...(process.env.FIREBASE_STORAGE_BUCKET
          ? {
              storageBucket:
                process.env.FIREBASE_STORAGE_BUCKET,
            }
          : {}),
      });

const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

export {
  firebaseApp,
  db,
  storage,
};
