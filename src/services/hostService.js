
import { db } from "../config/firebase.js";

import {
  isHostOnline,
  isHostAvailableForCalls,
  isWithinHostSchedule,
} from "./hostAvailabilityService.js";

const hostsCollection = db.collection("hosts");

const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 32;

const VALID_STATUSES = new Set(["pending", "active"]);
const RESTRICTED_STATUSES = new Set([
  "suspended",
  "rejected",
  "disabled",
  "banned",
]);

/* -------------------------------------------------------------------------- */
/* ERRORS                                                                     */
/* -------------------------------------------------------------------------- */

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/* -------------------------------------------------------------------------- */
/* VALIDATION                                                                 */
/* -------------------------------------------------------------------------- */

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
    normalized.includes("\0") ||
    /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    throw makeError(`Invalid ${fieldName}.`, 400);
  }

  return normalized;
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    throw makeError("A valid username is required.", 400);
  }

  const username = value.trim();

  if (
    username.length < 3 ||
    username.length > MAX_USERNAME_LENGTH ||
    !/^[a-zA-Z0-9_]+$/.test(username)
  ) {
    throw makeError(
      "Username must contain 3–32 letters, numbers, or underscores.",
      400
    );
  }

  return username;
}

function normalizeDisplayName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw makeError("Host display name is required.", 400);
  }

  const displayName = value.trim();

  if (
    displayName.length > MAX_DISPLAY_NAME_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(displayName)
  ) {
    throw makeError(
      "Host display name is invalid or too long.",
      400
    );
  }

  return displayName;
}

function validateHostProfile({
  firebaseUid,
  displayName,
  username,
}) {
  const uid = normalizeId(firebaseUid, "Firebase UID");
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const normalizedUsername = normalizeUsername(username);

  return {
    firebaseUid: uid,
    displayName: normalizedDisplayName,
    username: normalizedUsername,
    usernameLower: normalizedUsername.toLowerCase(),
  };
}

function normalizeDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw makeError("Invalid availability date.", 400);
  }

  return date;
}

function isRestrictedHost(host) {
  return RESTRICTED_STATUSES.has(
    String(host?.status || "").toLowerCase()
  );
}

/* -------------------------------------------------------------------------- */
/* HOST DOCUMENT SANITIZATION                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Internal backend representation.
 *
 * Never return this directly from a public API.
 */
function toHost(doc) {
  if (!doc?.exists) return null;

  const data = doc.data();

  const {
    linkCodeHash,
    password,
    passwordHash,
    resetToken,
    resetTokenHash,
    verificationToken,
    verificationTokenHash,
    privateNotes,
    ...safeData
  } = data;

  return {
    ...safeData,
    id: doc.id,
  };
}

/* -------------------------------------------------------------------------- */
/* SHARED AVAILABILITY                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Legacy one-to-one availability.
 *
 * A host with an active group room is not available for a
 * separate one-to-one call.
 */
export function isHostAvailable(host, date = new Date()) {
  if (!host || typeof host !== "object") {
    return false;
  }

  try {
    const now = normalizeDate(date);

    if (
      host.status !== "active" ||
      !host.firebaseUid ||
      !isHostOnline(host, now) ||
      host.acceptingCalls !== true ||
      host.activeCallId ||
      host.activeGroupRoomId
    ) {
      return false;
    }

    return isWithinHostSchedule(host, now) === true;
  } catch {
    return false;
  }
}

/**
 * Full asynchronous availability check.
 *
 * This is the function group matching should use.
 * It allows a host to accept additional customers when their
 * existing group room has capacity.
 */
export async function isHostAvailableForMatching(
  host,
  date = new Date()
) {
  if (!host || typeof host !== "object") {
    return false;
  }

  try {
    return await isHostAvailableForCalls(
      host,
      normalizeDate(date)
    );
  } catch (error) {
    console.error(
      "[SA LIVE] Host availability check failed:",
      host.id || "unknown",
      error?.message || "Unknown error"
    );

    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* CREATE WEBSITE HOST RECORD                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Call only from a trusted administrator approval workflow.
 *
 * Host records are created at:
 * hosts/{firebaseUid}
 *
 * The caller must already have verified administrator access.
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

  if (!VALID_STATUSES.has(status)) {
    throw makeError("Invalid initial host status.", 400);
  }

  const hostRef = hostsCollection.doc(profile.firebaseUid);
  const now = new Date();

  return db.runTransaction(async (transaction) => {
    const existingHostQuery = hostsCollection
      .where("firebaseUid", "==", profile.firebaseUid)
      .limit(2);

    const usernameQuery = hostsCollection
      .where("usernameLower", "==", profile.usernameLower)
      .limit(2);

    const publicUsernameQuery = hostsCollection
      .where("publicUsernameLower", "==", profile.usernameLower)
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

    const matchingUsernameDocs = new Map();

    for (const doc of [
      ...usernameSnapshot.docs,
      ...publicUsernameSnapshot.docs,
    ]) {
      matchingUsernameDocs.set(doc.id, doc);
    }

    const usernameConflict = [
      ...matchingUsernameDocs.keys(),
    ].some((id) => id !== hostRef.id);

    if (usernameConflict) {
      throw makeError(
        "That host username is already in use.",
        409
      );
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
        existingUsername !== profile.usernameLower ||
        existingPublicUsername !== profile.usernameLower
      ) {
        throw makeError(
          "The existing host username does not match the application. Administrator review is required.",
          409
        );
      }

      if (
        status === "pending" &&
        existing.status !== "pending"
      ) {
        throw makeError(
          "An existing host record is not pending. Administrator review is required.",
          409
        );
      }

      if (
        !VALID_STATUSES.has(existing.status)
      ) {
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
      usernameLower: profile.usernameLower,

      publicUsername: profile.username,
      publicUsernameLower: profile.usernameLower,

      displayName: profile.displayName,

      role: "host",
      status,

      acceptingCalls: false,
      availability: [],

      lastSeenAt: null,

      activeCallId: null,
      activeGroupRoomId: null,

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

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    throw makeError(
      "Multiple host records use the same Firebase account. Administrator review is required.",
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
 * The authenticated route must derive:
 *
 * hostId     = req.hostAccount.id
 * firebaseUid = req.user.uid
 *
 * Never accept these identity values from req.body.
 *
 * This updates the exact host document used by matching.
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

    if (host.firebaseUid !== uid) {
      throw makeError(
        "Host account does not match the authenticated user.",
        403
      );
    }

    if (host.status !== "active") {
      throw makeError(
        "Host account is not active.",
        403
      );
    }

    const now = new Date();

    transaction.update(hostRef, {
      lastSeenAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      online: true,
      lastSeenAt: now,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* GET AVAILABLE HOSTS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Backend-only host records.
 *
 * Includes hosts with free group-room capacity.
 * Do not send these internal records directly to customers.
 */
export async function getAvailableHosts() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const now = new Date();

  const candidates = snapshot.docs
    .map(toHost)
    .filter(Boolean);

  const results = await Promise.all(
    candidates.map(async (host) => {
      const available = await isHostAvailableForMatching(
        host,
        now
      );

      return available ? host : null;
    })
  );

  return results.filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* FIND AVAILABLE HOST                                                        */
/* -------------------------------------------------------------------------- */

export async function findAvailableHost() {
  const availableHosts = await getAvailableHosts();

  if (availableHosts.length === 0) {
    return null;
  }

  availableHosts.sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  return availableHosts[0];
}

/* -------------------------------------------------------------------------- */
/* RESERVE HOST FOR LEGACY ONE-TO-ONE CALL                                    */
/* -------------------------------------------------------------------------- */

/**
 * ONLY for legacy one-to-one calls.
 *
 * Do not use this for group calls.
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

    if (
      host.status !== "active" ||
      !host.firebaseUid
    ) {
      throw makeError(
        "Host is not active or linked to a website account.",
        409
      );
    }

    if (
      host.activeCallId ||
      host.activeGroupRoomId
    ) {
      throw makeError(
        "Host already has an active call or group room.",
        409
      );
    }

    const now = new Date();

    if (!isHostOnline(host, now)) {
      throw makeError("Host is offline.", 409);
    }

    if (host.acceptingCalls !== true) {
      throw makeError(
        "Host is not accepting calls.",
        409
      );
    }

    if (!isWithinHostSchedule(host, now)) {
      throw makeError(
        "Host is outside their availability schedule.",
        409
      );
    }

    transaction.update(hostRef, {
      activeCallId: normalizedCallId,
      updatedAt: now,
    });

    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* RELEASE HOST                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Releases only the matching legacy one-to-one reservation.
 *
 * A stale call cannot clear a newer reservation.
 * This never releases a group-room reservation.
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
      if (!host.activeCallId) {
        return true;
      }

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
