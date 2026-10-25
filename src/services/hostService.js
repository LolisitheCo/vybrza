
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

const hostsCollection = db.collection("hosts");

const HOST_TIMEOUT_MS = 45_000;
const MAX_ID_LENGTH = 256;

/*
|--------------------------------------------------------------------------
| VALIDATION HELPERS
|--------------------------------------------------------------------------
*/

function normalizeId(value, fieldName) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) {
    throw new Error(`${fieldName} is required.`);
  }

  const normalized = String(value).trim();

  if (
    normalized.length > MAX_ID_LENGTH ||
    normalized.includes("/")
  ) {
    throw new Error(`Invalid ${fieldName}.`);
  }

  return normalized;
}

function toHost(doc) {
  if (!doc?.exists) {
    return null;
  }

  const data = doc.data();

  // Never return internal account-linking secrets or credentials.
  const {
    linkCodeHash,
    telegramId,
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
    const result = new Date(value).getTime();

    return Number.isFinite(result) ? result : NaN;
  }

  return NaN;
}

function hasRecentHeartbeat(host, nowMs = Date.now()) {
  const lastSeenMs = getTimestampMilliseconds(host?.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  const ageMs = nowMs - lastSeenMs;

  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
}

function validateHostProfile({
  firebaseUid,
  displayName,
  username,
}) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  if (typeof displayName !== "string" || !displayName.trim()) {
    throw new Error("Host display name is required.");
  }

  if (displayName.trim().length > 100) {
    throw new Error("Host display name cannot exceed 100 characters.");
  }

  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(username.trim())
  ) {
    throw new Error(
      "Username must contain 3–32 letters, numbers, or underscores."
    );
  }

  return {
    firebaseUid: uid,
    displayName: displayName.trim(),
    username: username.trim(),
  };
}

/*
|--------------------------------------------------------------------------
| SHARED HOST AVAILABILITY
|--------------------------------------------------------------------------
| A host must:
| - Have an approved, active host record.
| - Be linked to a Firebase website account.
| - Be accepting calls.
| - Not already have an active call.
| - Have a recent heartbeat.
| - Be within their configured availability schedule.
|--------------------------------------------------------------------------
*/

export function isHostAvailable(host, date = new Date()) {
  if (!host || typeof host !== "object") {
    return false;
  }

  if (host.status !== "active" || !host.firebaseUid) {
    return false;
  }

  if (host.acceptingCalls !== true || host.activeCallId) {
    return false;
  }

  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return false;
  }

  if (!hasRecentHeartbeat(host, date.getTime())) {
    return false;
  }

  return isWithinHostSchedule(host, date);
}

/*
|--------------------------------------------------------------------------
| CREATE WEBSITE HOST RECORD
|--------------------------------------------------------------------------
| Call this from the approved host-application workflow.
| A host is linked directly to their Firebase website account.
| Do not create host accounts from Telegram IDs.
|--------------------------------------------------------------------------
*/


export async function createHost({
  firebaseUid,
  username,
  displayName = "SA LIVE Host",
  status = "active",
}) {
  const profile = validateHostProfile({
    firebaseUid,
    username,
    displayName,
  });

  if (!["pending", "active"].includes(status)) {
    throw new Error("Invalid initial host status.");
  }

  const usernameLower = profile.username.toLowerCase();
  const hostRef = hostsCollection.doc(profile.firebaseUid);
  const now = new Date();

  return db.runTransaction(async (transaction) => {
    const existingHostQuery = hostsCollection
      .where("firebaseUid", "==", profile.firebaseUid)
      .limit(2);

    const usernameQuery = hostsCollection
      .where("usernameLower", "==", usernameLower)
      .limit(2);

    const publicUsernameQuery = hostsCollection
      .where("publicUsernameLower", "==", usernameLower)
      .limit(2);

    // Complete all transaction reads before performing any writes.
    const [
      existingHostSnapshot,
      usernameSnapshot,
      publicUsernameSnapshot,
      hostSnapshot,
    ] = await Promise.all([
      transaction.get(existingHostQuery),
      transaction.get(usernameQuery),
      transaction.get(publicUsernameQuery),
      transaction.get(hostRef),
    ]);

    const duplicateAccount = existingHostSnapshot.docs.some(
      (doc) => doc.id !== hostRef.id
    );

    if (duplicateAccount) {
      throw new Error(
        "This Firebase account is already linked to another host record."
      );
    }

    const usernameConflict = [
      ...usernameSnapshot.docs,
      ...publicUsernameSnapshot.docs,
    ].some((doc) => doc.id !== hostRef.id);

    if (usernameConflict) {
      throw new Error("That host username is already in use.");
    }

    if (hostSnapshot.exists) {
      const existing = hostSnapshot.data();

      if (existing.firebaseUid !== profile.firebaseUid) {
        throw new Error(
          "Host record ID conflicts with another account."
        );
      }

      const existingUsername = String(
        existing.usernameLower || existing.username || ""
      ).toLowerCase();

      const existingPublicUsername = String(
        existing.publicUsernameLower ||
          existing.publicUsername ||
          existing.usernameLower ||
          existing.username ||
          ""
      ).toLowerCase();

      if (
        existingUsername !== usernameLower ||
        existingPublicUsername !== usernameLower
      ) {
        throw new Error(
          "The existing host username does not match the application. Administrator review is required."
        );
      }

      // Approval must never silently reuse an already-active host
      // record while its application is still being approved.
      if (status === "pending" && existing.status !== "pending") {
        throw new Error(
          "An existing host record is not pending. Administrator review is required."
        );
      }

      if (!["pending", "active"].includes(existing.status)) {
        throw new Error(
          "The existing host account is restricted and requires administrator review."
        );
      }

      return {
        ...toHost(hostSnapshot),
        alreadyExists: true,
      };
    }

    const hostData = {
      firebaseUid: profile.firebaseUid,
      username: profile.username,
      usernameLower,
      publicUsername: profile.username,
      publicUsernameLower: usernameLower,
      displayName: profile.displayName,
      role: "host",
      status,
      acceptingCalls: false,
      availability: [],
      lastSeenAt: null,
      activeCallId: null,
      availableHostEarningsCents: 0,
      lifetimeHostEarningsCents: 0,
      createdAt: now,
      updatedAt: now,
    };

    transaction.create(hostRef, hostData);

    return {
      id: hostRef.id,
      ...hostData,
      alreadyExists: false,
    };
  });
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
| HOST HEARTBEAT
|--------------------------------------------------------------------------
| Only the Firebase account attached to the host record can update
| its heartbeat. Heartbeats do not change host approval status.
|--------------------------------------------------------------------------
*/

export async function hostHeartbeat(hostId, firebaseUid) {
  const id = normalizeId(hostId, "Host ID");
  const uid = normalizeId(firebaseUid, "Firebase UID");
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

    if (host.firebaseUid !== uid) {
      throw new Error(
        "Host account does not match the authenticated user."
      );
    }

    const now = new Date();

    transaction.update(hostRef, {
      lastSeenAt: now,
      updatedAt: now,
    });

    return {
      lastSeenAt: now,
      activeCallId: host.activeCallId || null,
    };
  });
}

/*
|--------------------------------------------------------------------------
| GET AVAILABLE HOSTS
|--------------------------------------------------------------------------
| Returns internal records for backend matching only.
| Do not send these complete objects directly to website visitors.
|--------------------------------------------------------------------------
*/

export async function getAvailableHosts() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const now = new Date();

  return snapshot.docs
    .map(toHost)
    .filter((host) => isHostAvailable(host, now));
}

/*
|--------------------------------------------------------------------------
| FIND AVAILABLE HOST
|--------------------------------------------------------------------------
*/

export async function findAvailableHost() {
  const availableHosts = await getAvailableHosts();

  if (availableHosts.length === 0) {
    return null;
  }

  // Stable selection for now. Fair rotation can be added later.
  availableHosts.sort((a, b) => a.id.localeCompare(b.id));

  return availableHosts[0];
}

/*
|--------------------------------------------------------------------------
| RESERVE HOST FOR A CALL
|--------------------------------------------------------------------------
| Re-check availability transactionally to avoid assigning a host
| using stale search results.
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
      throw new Error("Host has not linked a website account.");
    }

    if (host.activeCallId) {
      throw new Error("Host is already in a call.");
    }

    if (!isHostAvailable(host, new Date())) {
      throw new Error(
        "Host is no longer available. Check their schedule and call status."
      );
    }

    transaction.update(hostRef, {
      activeCallId: normalizedCallId,
      updatedAt: new Date(),
    });

    return true;
  });
}

/*
|--------------------------------------------------------------------------
| RELEASE HOST
|--------------------------------------------------------------------------
| When a call ID is provided, it must match the host's current call.
| This prevents an old call from releasing a host reserved for a new one.
|--------------------------------------------------------------------------
*/

export async function releaseHost(hostId, callId = null) {
  const id = normalizeId(hostId, "Host ID");

  const normalizedCallId =
    callId === null ? null : normalizeId(callId, "Call ID");

  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host not found.");
    }

    const host = snapshot.data();

    if (normalizedCallId !== null) {
      if (host.activeCallId !== normalizedCallId) {
        throw new Error(
          "Call ID does not match the host's active call."
        );
      }
    } else if (host.activeCallId) {
      throw new Error(
        "A call ID is required before releasing an assigned host."
      );
    }

    transaction.update(hostRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });

    return true;
  });
}
