
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callsCollection = db.collection("callSessions");

const HOST_TIMEOUT_MS = 45_000;
const VALID_ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateId(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 150 ||
    !VALID_ID_PATTERN.test(value.trim())
  ) {
    throw makeError(`A valid ${fieldName} is required.`, 400);
  }

  return value.trim();
}

function timestampToMilliseconds(value) {
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
      return new Date(value).getTime();
    }
  } catch {
    return NaN;
  }

  return NaN;
}

function isHostAvailable(host) {
  if (!host || host.status !== "active") return false;
  if (typeof host.firebaseUid !== "string" || !host.firebaseUid.trim()) {
    return false;
  }

  if (host.activeCallId) return false;

  const lastSeenMs = timestampToMilliseconds(host.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) return false;

  const ageMs = Date.now() - lastSeenMs;

  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
}

function hasPaidMinutes(user) {
  if (!user || !Number.isSafeInteger(user.minutes)) {
    return false;
  }

  return user.minutes > 0;
}

function validateUserForMatching(user) {
  if (!user) {
    throw makeError("User not found.", 404);
  }

  if (user.verificationStatus !== "approved") {
    throw makeError(
      "Your account must be approved before you can start a call.",
      403
    );
  }

  if (!hasPaidMinutes(user)) {
    throw makeError(
      "You have no available minutes. Please buy minutes before starting a call.",
      409
    );
  }

  if (user.activeCallId) {
    throw makeError("You already have a call in progress.", 409);
  }
}

/**
 * Return only fields intended for public display.
 * Never send Firebase identifiers, payout details, internal state,
 * credentials, or link-code hashes to the customer.
 */
function toSafeHost(hostId, host) {
  const safeHost = { id: hostId };

  const publicFields = [
    "displayName",
    "name",
    "bio",
    "photoURL",
    "profileImage",
    "profilePicture",
    "avatarUrl",
    "language",
    "languages",
  ];

  for (const field of publicFields) {
    const value = host[field];

    if (
      typeof value === "string" ||
      (Array.isArray(value) &&
        value.every((item) => typeof item === "string"))
    ) {
      safeHost[field] = value;
    }
  }

  return safeHost;
}

/*
|--------------------------------------------------------------------------
| MATCH USER TO HOST
|--------------------------------------------------------------------------
| Creates a matched call and atomically reserves the customer and host.
|
| This function does NOT:
| - Add free minutes.
| - Deduct customer minutes.
| - Start the billable timer.
| - Create or join a LiveKit room.
| - Calculate host earnings.
|
| Those operations belong to other trusted backend services.
|--------------------------------------------------------------------------
*/

export async function matchUserToHost(userId) {
  const normalizedUserId = validateId(userId, "user ID");
  const userRef = usersCollection.doc(normalizedUserId);

  /*
  |--------------------------------------------------------------------------
  | LOAD HOST CANDIDATES
  |--------------------------------------------------------------------------
  */

  const hostSnapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  if (hostSnapshot.empty) {
    return {
      matched: false,
      host: null,
      call: null,
      retry: false,
      reason: "no_host_available",
    };
  }

  const candidates = hostSnapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((host) => isHostAvailable(host))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (candidates.length === 0) {
    return {
      matched: false,
      host: null,
      call: null,
      retry: false,
      reason: "no_host_available",
    };
  }

  /*
  |--------------------------------------------------------------------------
  | ATOMIC RESERVATION
  |--------------------------------------------------------------------------
  | Candidate availability can change after discovery, so the user and host
  | are re-read and checked within each transaction.
  |--------------------------------------------------------------------------
  */

  for (const candidate of candidates) {
    const hostRef = hostsCollection.doc(candidate.id);
    const callRef = callsCollection.doc();

    const result = await db.runTransaction(async (transaction) => {
      // Read all documents before making any transaction writes.
      const [userSnapshot, hostSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(hostRef),
      ]);

      if (!userSnapshot.exists) {
        throw makeError("User not found.", 404);
      }

      if (!hostSnapshot.exists) {
        return {
          matched: false,
          reason: "host_unavailable",
        };
      }

      const user = userSnapshot.data();
      const host = hostSnapshot.data();

      validateUserForMatching(user);

      if (!isHostAvailable(host)) {
        return {
          matched: false,
          reason: "host_unavailable",
        };
      }

      // Recheck the current heartbeat inside the transaction.
      const lastSeenMs = timestampToMilliseconds(host.lastSeenAt);
      const ageMs = Date.now() - lastSeenMs;

      if (
        !Number.isFinite(lastSeenMs) ||
        ageMs < 0 ||
        ageMs > HOST_TIMEOUT_MS
      ) {
        return {
          matched: false,
          reason: "host_unavailable",
        };
      }

      const now = new Date();

      /*
       * Keep this schema aligned with callService.js and billingService.js.
       * Money values are stored in both cents (integer arithmetic) and
       * currency units for display/compatibility.
       */
      const callData = {
        userId: normalizedUserId,
        hostId: hostRef.id,

        status: "matched",

        roomId: null,
        roomUrl: null,

        startedAt: null,
        endedAt: null,

        durationSeconds: 0,
        minutesUsed: 0,
        billableMinutes: 0,

        endReason: null,

        billingStatus: "pending",
        billedAt: null,
        billingError: null,

        customerCharge: 0,
        hostEarnings: 0,
        saLiveRevenue: 0,

        customerChargeCents: 0,
        hostEarningsCents: 0,
        saLiveRevenueCents: 0,

        hostPayoutStatus: "pending",

        createdAt: now,
        updatedAt: now,
      };

      // Reserve both records and create the call atomically.
      transaction.update(hostRef, {
        activeCallId: callRef.id,
        updatedAt: now,
      });

      transaction.update(userRef, {
        activeCallId: callRef.id,
        updatedAt: now,
      });

      transaction.create(callRef, callData);

      return {
        matched: true,
        callId: callRef.id,
        call: callData,
        host: toSafeHost(hostRef.id, host),
      };
    });

    if (result.matched) {
      return {
        matched: true,
        host: result.host,
        call: {
          id: result.callId,
          ...result.call,
        },
        retry: false,
      };
    }

    // The host became unavailable; try the next candidate.
  }

  return {
    matched: false,
    host: null,
    call: null,
    retry: true,
    reason: "hosts_became_unavailable",
  };
}
