
import { createHash, randomBytes } from "node:crypto";
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const HOST_TIMEOUT_SECONDS = 45;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function hashLinkCode(code) {
  return createHash("sha256")
    .update(String(code))
    .digest("hex");
}

function toHost(doc) {
  return {
    id: doc.id,
    ...doc.data(),
  };
}

/*
|--------------------------------------------------------------------------
| CREATE HOST APPLICATION
|--------------------------------------------------------------------------
| New hosts start as pending, never automatically active.
| The link code must be delivered to the approved host securely.
|--------------------------------------------------------------------------
*/

export async function createHost({
  telegramId,
  username = null,
  displayName = "SA LIVE Host",
}) {
  if (!telegramId) {
    throw new Error("Telegram ID is required.");
  }

  const telegramIdString = String(telegramId);
  const existing = await getHostByTelegramId(telegramIdString);

  if (existing) {
    return existing;
  }

  const linkCode = randomBytes(24).toString("hex");
  const now = new Date();

  const hostData = {
    telegramId: telegramIdString,
    username,
    displayName,

    role: "host",
    status: "pending",
    firebaseUid: null,

    // Only the hash is stored in Firestore.
    linkCodeHash: hashLinkCode(linkCode),

    lastSeenAt: null,
    activeCallId: null,

    createdAt: now,
    updatedAt: now,
  };

  const docRef = await hostsCollection.add(hostData);

  // Keep this code secure. Show it only through a trusted
  // admin workflow after the host's application is approved.
  return {
    id: docRef.id,
    ...hostData,
    linkCode,
  };
}

/*
|--------------------------------------------------------------------------
| GET HOST BY TELEGRAM ID
|--------------------------------------------------------------------------
*/

export async function getHostByTelegramId(telegramId) {
  const snapshot = await hostsCollection
    .where("telegramId", "==", String(telegramId))
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  return toHost(snapshot.docs[0]);
}

/*
|--------------------------------------------------------------------------
| GET HOST BY FIREBASE UID
|--------------------------------------------------------------------------
*/

export async function getHostByFirebaseUid(firebaseUid) {
  const snapshot = await hostsCollection
    .where("firebaseUid", "==", String(firebaseUid))
    .limit(2)
    .get();

  if (snapshot.empty) return null;

  if (snapshot.size > 1) {
    throw new Error(
      "Multiple host records use the same Firebase account."
    );
  }

  return toHost(snapshot.docs[0]);
}

/*
|--------------------------------------------------------------------------
| GET HOST BY DOCUMENT ID
|--------------------------------------------------------------------------
*/

export async function getHostById(hostId) {
  const doc = await hostsCollection.doc(hostId).get();

  if (!doc.exists) return null;

  return toHost(doc);
}

/*
|--------------------------------------------------------------------------
| LINK APPROVED HOST TO FIREBASE ACCOUNT
|--------------------------------------------------------------------------
| The host must provide the one-time code issued for their
| application. Never accept a Firebase UID as proof of identity.
|--------------------------------------------------------------------------
*/

export async function linkHostAccount(firebaseUid, linkCode) {
  if (!firebaseUid || !linkCode) {
    throw new Error("Firebase account and link code are required.");
  }

  const codeHash = hashLinkCode(linkCode);

  const snapshot = await hostsCollection
    .where("linkCodeHash", "==", codeHash)
    .limit(2)
    .get();

  if (snapshot.empty) {
    throw new Error("Invalid or expired host link code.");
  }

  if (snapshot.size > 1) {
    throw new Error("Host link code is not unique.");
  }

  const hostRef = snapshot.docs[0].ref;

  return db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account not found.");
    }

    const host = hostSnapshot.data();

    if (host.status !== "active") {
      throw new Error(
        "Your host application must be approved before linking."
      );
    }

    if (host.firebaseUid) {
      throw new Error(
        "This host is already linked to a website account."
      );
    }

    const existingAccount = await db
      .collection("hosts")
      .where("firebaseUid", "==", String(firebaseUid))
      .limit(1)
      .get();

    if (!existingAccount.empty) {
      throw new Error(
        "This Firebase account is already linked to a host."
      );
    }

    transaction.update(hostRef, {
      firebaseUid: String(firebaseUid),
      linkCodeHash: null,
      linkedAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      id: hostRef.id,
      firebaseUid: String(firebaseUid),
      displayName: host.displayName,
      status: "active",
    };
  });
}

/*
|--------------------------------------------------------------------------
| HOST HEARTBEAT
|--------------------------------------------------------------------------
*/

export async function hostHeartbeat(hostId) {
  const hostRef = hostsCollection.doc(hostId);
  const snapshot = await hostRef.get();

  if (!snapshot.exists) {
    throw new Error("Host not found.");
  }

  const host = snapshot.data();

  if (host.status !== "active") {
    throw new Error("Host account is not active.");
  }

  const now = new Date();

  await hostRef.update({
    lastSeenAt: now,
    updatedAt: now,
  });

  return {
    id: hostId,
    lastSeenAt: now,
    activeCallId: host.activeCallId || null,
  };
}

/*
|--------------------------------------------------------------------------
| CHECK HOST AVAILABILITY
|--------------------------------------------------------------------------
*/

export function isHostAvailable(host) {
  if (host.status !== "active") return false;
  if (!host.firebaseUid) return false;
  if (host.activeCallId) return false;
  if (!host.lastSeenAt) return false;

  const lastSeen =
    typeof host.lastSeenAt.toDate === "function"
      ? host.lastSeenAt.toDate()
      : new Date(host.lastSeenAt);

  const ageSeconds =
    (Date.now() - lastSeen.getTime()) / 1000;

  return (
    Number.isFinite(ageSeconds) &&
    ageSeconds >= 0 &&
    ageSeconds <= HOST_TIMEOUT_SECONDS
  );
}

/*
|--------------------------------------------------------------------------
| GET AVAILABLE HOSTS
|--------------------------------------------------------------------------
*/

export async function getAvailableHosts() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  return snapshot.docs
    .map(toHost)
    .filter(isHostAvailable);
}

/*
|--------------------------------------------------------------------------
| FIND AVAILABLE HOST
|--------------------------------------------------------------------------
*/

export async function findAvailableHost() {
  const hosts = await getAvailableHosts();

  if (hosts.length === 0) return null;

  return hosts[0];
}

/*
|--------------------------------------------------------------------------
| RESERVE HOST FOR A CALL
|--------------------------------------------------------------------------
*/

export async function reserveHost(hostId, callId) {
  if (!callId) {
    throw new Error("Call ID is required.");
  }

  const hostRef = hostsCollection.doc(hostId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host not found.");
    }

    const host = snapshot.data();

    if (host.status !== "active") {
      throw new Error("Host is not active.");
    }

    if (!host.firebaseUid) {
      throw new Error("Host has not linked a website account.");
    }

    if (host.activeCallId) {
      throw new Error("Host is already in a call.");
    }

    if (!isHostAvailable(host)) {
      throw new Error("Host is no longer available.");
    }

    transaction.update(hostRef, {
      activeCallId: String(callId),
      updatedAt: new Date(),
    });

    return true;
  });
}

/*
|--------------------------------------------------------------------------
| RELEASE HOST
|--------------------------------------------------------------------------
*/

export async function releaseHost(hostId) {
  const hostRef = hostsCollection.doc(hostId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host not found.");
    }

    transaction.update(hostRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });
  });
}