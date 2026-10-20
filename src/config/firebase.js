import dotenv from "dotenv";
import fs from "fs";

import {
  getApps,
  initializeApp,
  cert,
} from "firebase-admin/app";

import {
  getFirestore,
} from "firebase-admin/firestore";

import {
  getStorage,
} from "firebase-admin/storage";

dotenv.config();

/*
|--------------------------------------------------------------------------
| SERVICE ACCOUNT
|--------------------------------------------------------------------------
*/

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  "./firebase-service-account.json";

if (!fs.existsSync(serviceAccountPath)) {
  throw new Error(
    `Firebase service account file not found: ${serviceAccountPath}`
  );
}

const serviceAccount = JSON.parse(
  fs.readFileSync(
    serviceAccountPath,
    "utf8"
  )
);

/*
|--------------------------------------------------------------------------
| FIREBASE ADMIN INITIALIZATION
|--------------------------------------------------------------------------
*/

let firebaseApp;

if (getApps().length === 0) {
  firebaseApp = initializeApp({
    credential: cert(serviceAccount),

    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET,
  });
} else {
  firebaseApp = getApps()[0];
}

/*
|--------------------------------------------------------------------------
| FIRESTORE
|--------------------------------------------------------------------------
*/

const db =
  getFirestore(firebaseApp);

/*
|--------------------------------------------------------------------------
| STORAGE
|--------------------------------------------------------------------------
*/

const storage =
  getStorage(firebaseApp);

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

export {
  firebaseApp,
  db,
  storage,
};