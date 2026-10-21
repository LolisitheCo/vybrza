
import { createHash, randomBytes } from "node:crypto";
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const accountLinksCollection = db.collection("hostAccountLinks");

const HOST_TIMEOUT_MS = 45_000;
const MAX_LINK_CODE_LENGTH = 256;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function normalizeId(value, fieldName) {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    throw new Error(`${fieldName} is required.`);
  }

  const normalized = String(value).trim();

  if (
    !normalized ||
    normalized.length > 256
  ) {
    throw new Error(`Invalid ${fieldName}.`);
  }

  return normalized;
}

function hashLinkCode(code) {
  return createHash("sha256")
    .update(code, "utf8")
    .digest("hex");
}

/*
 * Never expose linkCodeHash through ordinary host lookup functions.
 * The raw linkCode is returned only once by createHost().
 */
function toHost(doc) {
  if (!doc?.exists) {
    return null;
  }

  const data = doc.data();

  const {
    linkCodeHash,
    ...safeData
  } = data;

  return {
    id: doc.id,
    ...safeData,
  };
}

function getTimestampMilliseconds(value) {
  if (!value) {
    return NaN;
  }

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).getTime();
  }

  return NaN;
}

function isValidLinkCode(code) {
  return (
    typeof code === "string" &&
    code.length >= 32 &&
    code.length <= MAX_LINK_CODE_LENGTH &&
    /^[a-f0-9]+$/i.test(code)
  );
}

/*
|--------------------------------------------------------------------------
| CREATE HOST
|--------------------------------------------------------------------------
| New hosts are pending by default.
| Existing hosts are not silently overwritten.
| Only the raw one-time link code is returned to the caller.
|--------------------------------------------------------------------------
*/

export async function createHost({
  telegramId,
  username = null,
  displayName = "SA LIVE Host",
}) {
  const normalizedTelegramId = normalizeId(
    telegramId,
    "Telegram ID"
  );

  const normalizedUsername =
    typeof username === "string" && username.trim()
      ? username.trim().slice(0, 64)
      : null;

  const normalizedDisplayName =
    typeof displayName === "string" && displayName.trim()
      ? displayName.trim().slice(0, 100)
      : "SA LIVE Host";

  const hostRef = hostsCollection.doc(
    `tg_${normalizedTelegramId}`
  );

  const linkCode = randomBytes(32).toString("hex");
  const now = new Date();

  const hostData = {
    telegramId: normalizedTelegramId,
    username: normalizedUsername,
    displayName: normalizedDisplayName,

    role: "host",
    status: "pending",
    firebaseUid: null,

    linkCodeHash: hashLinkCode(linkCode),

    lastSeenAt: null,
    activeCallId: null,

    createdAt: now,
    updatedAt: now,
  };

  const result = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(hostRef);

    if (existing.exists) {
      return {
        created: false,
        host: toHost(existing),
      };
    }

    transaction.create(hostRef, hostData);

    return {
      created: true,
      host: {
        id: hostRef.id,
        ...hostData,
      },
    };
  });

  if (!result.created) {
    return {
      ...result.host,
      alreadyExists: true,
    };
  }

  // Return this code only through a trusted, authorized workflow.
  // Never send it to public host APIs or ordinary client responses.
  const {
    linkCodeHash,
    ...safeHost
  } = result.host;

  return {
    ...safeHost,
    linkCode,
    alreadyExists: false,
  };
}

/*
|--------------------------------------------------------------------------
| GET HOST BY TELEGRAM ID
|--------------------------------------------------------------------------
*/

export async function getHostByTelegramId(telegramId) {
  const normalizedTelegramId = normalizeId(
    telegramId,
    "Telegram ID"
  );

  const snapshot = await hostsCollection
    .where("telegramId", "==", normalizedTelegramId)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    throw new Error(
      "Multiple host records use the same Telegram ID."
    );
  }

  return toHost(snapshot.docs[0]);
}

/*
|--------------------------------------------------------------------------
| GET HOST BY FIREBASE UID
|--------------------------------------------------------------------------
*/

export async function getHostByFirebaseUid(firebaseUid) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  const snapshot = await hostsCollection
    .where("firebaseUid", "==", uid)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

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
  const id = normalizeId(hostId, "Host ID");

  const snapshot = await hostsCollection.doc(id).get();

  return toHost(snapshot);
}

/*
|--------------------------------------------------------------------------
| LINK APPROVED HOST TO FIREBASE ACCOUNT
|--------------------------------------------------------------------------
| Requires:
| 1. A valid Firebase UID obtained from verified authentication.
| 2. A one-time link code issued to the approved host.
|
| A deterministic account-link document prevents concurrent
| successful linking of the same Firebase UID to different hosts.
|--------------------------------------------------------------------------
*/

export async function linkHostAccount(firebaseUid, linkCode) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  if (!isValidLinkCode(linkCode)) {
    throw new Error("Invalid or expired host link code.");
  }

  const codeHash = hashLinkCode(linkCode);

  // Locate the host using the one-way hash of the link code.
  const matchingHosts = await hostsCollection
    .where("linkCodeHash", "==", codeHash)
    .limit(2)
    .get();

  if (matchingHosts.empty) {
    throw new Error("Invalid or expired host link code.");
  }

  if (matchingHosts.size > 1) {
    throw new Error("Host link code is not unique.");
  }

  const hostRef = matchingHosts.docs[0].ref;
  const accountLinkRef = accountLinksCollection.doc(uid);

  // Detect existing legacy links before entering the transaction.
  // The deterministic account-link document enforces uniqueness
  // for all successful uses of this updated linking workflow.
  const existingHostSnapshot = await hostsCollection
    .where("firebaseUid", "==", uid)
    .limit(1)
    .get();

  if (!existingHostSnapshot.empty) {
    const existingHost = existingHostSnapshot.docs[0];

    if (existingHost.id !== hostRef.id) {
      throw new Error(
        "This Firebase account is already linked to another host."
      );
    }
  }

  return db.runTransaction(async (transaction) => {
    // Complete all reads before writing.
    const [
      hostSnapshot,
      accountLinkSnapshot,
    ] = await Promise.all([
      transaction.get(hostRef),
      transaction.get(accountLinkRef),
    ]);

    if (!hostSnapshot.exists) {
      throw new Error("Host account not found.");
    }

    const host = hostSnapshot.data();

    if (host.linkCodeHash !== codeHash) {
      throw new Error("Invalid or expired host link code.");
    }

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

    if (accountLinkSnapshot.exists) {
      throw new Error(
        "This Firebase account is already linked to a host."
      );
    }

    const now = new Date();

    transaction.create(accountLinkRef, {
      firebaseUid: uid,
      hostId: hostRef.id,
      createdAt: now,
    });

    transaction.update(hostRef, {
      firebaseUid: uid,
      linkCodeHash: null,
      linkedAt: now,
      updatedAt: now,
    });

    return {
      id: hostRef.id,
      firebaseUid: uid,
      displayName: host.displayName || "SA LIVE Host",
      status: "active",
    };
  });
}

/*
|--------------------------------------------------------------------------
| HOST HEARTBEAT
|--------------------------------------------------------------------------
| The controller must supply the host ID established by authentication.
|--------------------------------------------------------------------------
*/

export async function hostHeartbeat(hostId) {
  const id = normalizeId(hostId, "Host ID");
  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host not found.");
    }

    const host = snapshot.data();

    if (host.status !== "active") {
      throw new Error("Host account is not active.");
    }

    const now = new Date();

    transaction.update(hostRef, {
      lastSeenAt: now,
      updatedAt: now,
    });

    return {
      id,
      lastSeenAt: now,
      activeCallId: host.activeCallId || null,
    };
  });
}

/*
|--------------------------------------------------------------------------
| CHECK HOST AVAILABILITY
|--------------------------------------------------------------------------
*/

export function isHostAvailable(host) {
  if (!host || typeof host !== "object") {
    return false;
  }

  if (host.status !== "active") {
    return false;
  }

  if (!host.firebaseUid) {
    return false;
  }

  if (host.activeCallId) {
    return false;
  }

  if (!host.lastSeenAt) {
    return false;
  }

  const lastSeenMs = getTimestampMilliseconds(
    host.lastSeenAt
  );

  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  const ageMs = Date.now() - lastSeenMs;

  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
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

  if (hosts.length === 0) {
    return null;
  }

  // Deterministic selection for predictable behaviour.
  // Actual reservation must still be performed transactionally.
  hosts.sort((a, b) => a.id.localeCompare(b.id));

  return hosts[0];
}

/*
|--------------------------------------------------------------------------
| RESERVE HOST FOR A CALL
|--------------------------------------------------------------------------
| Atomic reservation: concurrent customers cannot both reserve
| the same host using this function.
|--------------------------------------------------------------------------
*/

export async function reserveHost(hostId, callId) {
  const id = normalizeId(hostId, "Host ID");
  const normalizedCallId = normalizeId(callId, "Call ID");

  const hostRef = hostsCollection.doc(id);

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
      throw new Error(
        "Host has not linked a website account."
      );
    }

    if (host.activeCallId) {
      throw new Error("Host is already in a call.");
    }

    if (!isHostAvailable(host)) {
      throw new Error("Host is no longer available.");
    }

    const now = new Date();

    transaction.update(hostRef, {
      activeCallId: normalizedCallId,
      updatedAt: now,
    });

    return true;
  });
}

/*
|--------------------------------------------------------------------------
| RELEASE HOST
|--------------------------------------------------------------------------
| When callId is supplied, only that call may release the host.
| Existing callers can continue calling releaseHost(hostId).
| Prefer supplying callId to prevent stale calls from releasing
| a host who has already been assigned to another call.
|--------------------------------------------------------------------------
*/

export async function releaseHost(hostId, callId = null) {
  const id = normalizeId(hostId, "Host ID");

  if (callId !== null) {
    callId = normalizeId(callId, "Call ID");
  }

  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host not found.");
    }

    const host = snapshot.data();

    if (callId !== null && host.activeCallId !== callId) {
      throw new Error(
        "Call ID does not match the host's active call."
      );
    }

    transaction.update(hostRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });

    return true;
  });
}
