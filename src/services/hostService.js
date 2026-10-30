
import { db } from "../config/firebase.js";

import {
  isHostOnline,
  isHostAvailableForCalls,
  isWithinHostSchedule,
} from "./hostAvailabilityService.js";

const hostsCollection = db.collection("hosts");

const MAX_ID_LENGTH = 256;

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
    normalized.includes("\0")
  ) {
    throw makeError(`Invalid ${fieldName}.`, 400);
  }

  return normalized;
}

function validateHostProfile({
  firebaseUid,
  displayName,
  username,
}) {
  const uid = normalizeId(firebaseUid, "Firebase UID");

  if (
    typeof displayName !== "string" ||
    !displayName.trim()
  ) {
    throw makeError(
      "Host display name is required.",
      400
    );
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

  const normalizedUsername = username.trim();

  return {
    firebaseUid: uid,
    displayName: normalizedDisplayName,
    username: normalizedUsername,
    usernameLower: normalizedUsername.toLowerCase(),
  };
}

/* -------------------------------------------------------------------------- */
/* HOST DOCUMENT SANITIZATION                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Internal backend host representation.
 *
 * This is NOT a public API response. Public endpoints must use
 * getPublicHostDirectory() from hostAvailabilityService.js.
 */
function toHost(doc) {
  if (!doc?.exists) return null;

  const data = doc.data();

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

/* -------------------------------------------------------------------------- */
/* SHARED AVAILABILITY                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Synchronous availability check for legacy one-to-one callers.
 *
 * Group-room availability is checked asynchronously by
 * isHostAvailableForCalls() and must be used by group matching.
 */
export function isHostAvailable(host, date = new Date()) {
  if (!host || typeof host !== "object") {
    return false;
  }

  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return false;
  }

  if (!isHostOnline(host, date)) {
    return false;
  }

  if (host.acceptingCalls !== true) {
    return false;
  }

  if (host.activeCallId || host.activeGroupRoomId) {
    return false;
  }

  return isWithinHostSchedule(host, date);
}

/**
 * Full asynchronous availability check.
 *
 * This supports a host who is already in a group room with
 * available customer capacity.
 */
export async function isHostAvailableForMatching(
  host,
  date = new Date()
) {
  return isHostAvailableForCalls(host, date);
}

/* -------------------------------------------------------------------------- */
/* CREATE WEBSITE HOST RECORD                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Call only from a trusted host-approval workflow.
 *
 * The route/controller must enforce administrator authorization.
 *
 * Host records are keyed by Firebase UID:
 * hosts/{firebaseUid}
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
    throw makeError(
      "Invalid initial host status.",
      400
    );
  }

  const hostRef = hostsCollection.doc(
    profile.firebaseUid
  );

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

    const duplicateAccount =
      existingHostSnapshot.docs.some(
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
        existing.usernameLower ||
        existing.username ||
        ""
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
        !["pending", "active"].includes(existing.status)
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
  const uid = normalizeId(
    firebaseUid,
    "Firebase UID"
  );

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

  const snapshot = await hostsCollection
    .doc(id)
    .get();

  return toHost(snapshot);
}

/* -------------------------------------------------------------------------- */
/* HOST HEARTBEAT                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The route must:
 * 1. Verify the Firebase ID token.
 * 2. Derive firebaseUid from req.user.uid.
 * 3. Derive hostId from req.hostAccount.id.
 *
 * Never accept either identity from an untrusted request body.
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
      throw makeError(
        "Host account is not active.",
        403
      );
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
      success: true,
      online: true,
      lastSeenAt: now,
      activeCallId: host.activeCallId || null,
      activeGroupRoomId: host.activeGroupRoomId || null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* GET AVAILABLE HOSTS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Backend-only host records.
 *
 * Includes:
 * - available hosts without an active room;
 * - available hosts with a group room that has a free seat.
 *
 * Does not return public-safe profiles. Do not send these records
 * directly to customers.
 */
export async function getAvailableHosts() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const now = new Date();

  const candidates = snapshot.docs
    .map(toHost)
    .filter(Boolean);

  const availabilityResults = await Promise.all(
    candidates.map(async (host) => {
      try {
        const available =
          await isHostAvailableForMatching(host, now);

        return available ? host : null;
      } catch (error) {
        console.error(
          "Host availability check failed:",
          host.id,
          error?.code || "UNKNOWN_ERROR"
        );

        return null;
      }
    })
  );

  return availabilityResults.filter(Boolean);
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
 * This function is ONLY for legacy one-to-one reservations.
 *
 * Do not use it for group calls.
 * Group calls must reserve a customer seat in callRooms and
 * update the host's activeGroupRoomId atomically.
 *
 * The group matching service must enforce the room capacity.
 */
export async function reserveHost(hostId, callId) {
  const id = normalizeId(hostId, "Host ID");
  const normalizedCallId = normalizeId(
    callId,
    "Call ID"
  );

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
      throw makeError(
        "Host is offline.",
        409
      );
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
 * This function does not release group-room reservations.
 */
export async function releaseHost(hostId, callId) {
  const id = normalizeId(hostId, "Host ID");
  const normalizedCallId = normalizeId(
    callId,
    "Call ID"
  );

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

    const now = new Date();

    transaction.update(hostRef, {
      activeCallId: null,
      updatedAt: now,
    });

    return true;
  });
}
