
import { db } from "../config/firebase.js";
import { isWithinHostSchedule } from "./hostAvailabilityService.js";

const hostsCollection = db.collection("hosts");

const HOST_TIMEOUT_MS = 45_000;
const MAX_ID_LENGTH = 256;

/* -------------------------------------------------------------------------- */
/* VALIDATION HELPERS                                                         */
/* -------------------------------------------------------------------------- */

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeId(value, fieldName) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) {
    throw makeError(`${fieldName} is required.`, 400);
  }

  const normalized = String(value).trim();

  if (
    normalized.length > MAX_ID_LENGTH ||
    normalized.includes("/") ||
    normalized.includes("\0")
  ) {
    throw makeError(`Invalid ${fieldName}.`, 400);
  }

  return normalized;
}

function toHost(doc) {
  if (!doc?.exists) return null;

  const data = doc.data();

  // Exclude internal identifiers and credentials from returned host objects.
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
  if (!value) return NaN;

  try {
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
  } catch {
    return NaN;
  }

  return NaN;
}

function hasRecentHeartbeat(host, nowMs = Date.now()) {
  const lastSeenMs = getTimestampMilliseconds(host?.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) return false;

  const ageMs = nowMs - lastSeenMs;
  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
}

function validateHostProfile({ firebaseUid, displayName, username }) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  if (typeof displayName !== "string" || !displayName.trim()) {
    throw makeError("Host display name is required.", 400);
  }

  const normalizedDisplayName = displayName.trim();

  if (normalizedDisplayName.length > 100) {
    throw makeError(
      "Host display name cannot exceed 100 characters.",
      400
    );
  }

  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(username.trim())
  ) {
    throw makeError(
      "Username must contain 3–32 letters, numbers, or underscores.",
      400
    );
  }

  return {
    firebaseUid: uid,
    displayName: normalizedDisplayName,
    username: username.trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* SHARED HOST AVAILABILITY                                                   */
/* -------------------------------------------------------------------------- */

export function isHostAvailable(host, date = new Date()) {
  if (!host || typeof host !== "object") return false;
  if (host.status !== "active" || !host.firebaseUid) return false;
  if (host.acceptingCalls !== true) return false;

  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return false;
  }

  if (!hasRecentHeartbeat(host, date.getTime())) return false;

  // A host with a one-to-one reservation cannot accept another call
  // unless group-room matching explicitly handles that reservation.
  if (host.activeCallId) return false;

  return isWithinHostSchedule(host, date);
}

/* -------------------------------------------------------------------------- */
/* CREATE WEBSITE HOST RECORD                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Call from a trusted, authenticated and authorized host-approval workflow.
 *
 * This function does not itself prove that the caller is an administrator.
 * The route/controller must enforce administrator authorization.
 */
export async function createHost({
  firebaseUid,
  username,
  displayName = "SA LIVE Host",
  status = "pending",
}) {
  const profile = validateHostProfile({
    firebaseUid,
    username,
    displayName,
  });

  if (!["pending", "active"].includes(status)) {
    throw makeError("Invalid initial host status.", 400);
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
      throw makeError(
        "This Firebase account is already linked to another host record.",
        409
      );
    }

    const usernameConflict = [
      ...usernameSnapshot.docs,
      ...publicUsernameSnapshot.docs,
    ].some((doc) => doc.id !== hostRef.id);

    if (usernameConflict) {
      throw makeError("That host username is already in use.", 409);
    }

    if (hostSnapshot.exists) {
      const existing = hostSnapshot.data();

      if (existing.firebaseUid !== profile.firebaseUid) {
        throw makeError(
          "Host record ID conflicts with another account.",
          409
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
        throw makeError(
          "The existing host username does not match the application. Administrator review is required.",
          409
        );
      }

      if (status === "pending" && existing.status !== "pending") {
        throw makeError(
          "An existing host record is not pending. Administrator review is required.",
          409
        );
      }

      if (!["pending", "active"].includes(existing.status)) {
        throw makeError(
          "The existing host account is restricted and requires administrator review.",
          409
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

/* -------------------------------------------------------------------------- */
/* GET HOST BY FIREBASE UID                                                   */
/* -------------------------------------------------------------------------- */

export async function getHostByFirebaseUid(firebaseUid) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  const snapshot = await hostsCollection
    .where("firebaseUid", "==", uid)
    .limit(2)
    .get();

  if (snapshot.empty) return null;

  if (snapshot.size > 1) {
    throw makeError(
      "Multiple host records use the same Firebase account.",
      500
    );
  }

  return toHost(snapshot.docs[0]);
}

/* -------------------------------------------------------------------------- */
/* GET HOST BY DOCUMENT ID                                                    */
/* -------------------------------------------------------------------------- */

export async function getHostById(hostId) {
  const id = normalizeId(hostId, "Host ID");
  const snapshot = await hostsCollection.doc(id).get();

  return toHost(snapshot);
}

/* -------------------------------------------------------------------------- */
/* HOST HEARTBEAT                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The route must authenticate the Firebase token and derive firebaseUid
 * from that verified token, not from an untrusted request body.
 */
export async function hostHeartbeat(hostId, firebaseUid) {
  const id = normalizeId(hostId, "Host ID");
  const uid = normalizeId(firebaseUid, "Firebase UID");
  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw makeError("Host not found.", 404);
    }

    const host = snapshot.data();

    if (host.status !== "active") {
      throw makeError("Host account is not active.", 403);
    }

    if (host.firebaseUid !== uid) {
      throw makeError(
        "Host account does not match the authenticated user.",
        403
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

/* -------------------------------------------------------------------------- */
/* GET AVAILABLE HOSTS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Backend-only host records. Do not return these full records directly
 * from a public endpoint.
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

/* -------------------------------------------------------------------------- */
/* FIND AVAILABLE HOST                                                        */
/* -------------------------------------------------------------------------- */

export async function findAvailableHost() {
  const availableHosts = await getAvailableHosts();

  if (availableHosts.length === 0) return null;

  availableHosts.sort((a, b) => a.id.localeCompare(b.id));

  return availableHosts[0];
}

/* -------------------------------------------------------------------------- */
/* RESERVE HOST FOR A CALL                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Atomically reserves an available host.
 *
 * The caller must also reserve the customer and create/update the call
 * session in a coordinated transaction. This function alone does not
 * reserve the customer or create a call.
 */
export async function reserveHost(hostId, callId) {
  const id = normalizeId(hostId, "Host ID");
  const normalizedCallId = normalizeId(callId, "Call ID");
  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw makeError("Host not found.", 404);
    }

    const host = snapshot.data();

    if (host.status !== "active" || !host.firebaseUid) {
      throw makeError("Host is not active or linked to a website account.", 409);
    }

    if (host.activeCallId) {
      throw makeError("Host is already in a call.", 409);
    }

    if (!isHostAvailable(host, new Date())) {
      throw makeError(
        "Host is no longer available. Check their schedule and call status.",
        409
      );
    }

    transaction.update(hostRef, {
      activeCallId: normalizedCallId,
      updatedAt: new Date(),
    });

    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* RELEASE HOST                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Requires the call ID to match the current reservation.
 * An old call cannot release a host assigned to a newer call.
 */
export async function releaseHost(hostId, callId) {
  const id = normalizeId(hostId, "Host ID");
  const normalizedCallId = normalizeId(callId, "Call ID");
  const hostRef = hostsCollection.doc(id);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw makeError("Host not found.", 404);
    }

    const host = snapshot.data();

    if (host.activeCallId !== normalizedCallId) {
      // Idempotent if already released; do not affect another call.
      if (!host.activeCallId) return true;

      throw makeError(
        "Call ID does not match the host's active call.",
        409
      );
    }

    transaction.update(hostRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });

    return true;
  });
}
