
import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callsCollection = db.collection("callSessions");

const HOST_TIMEOUT_MS = 45_000;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function timestampToMilliseconds(value) {
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

function isHostAvailable(host) {
  if (!host || host.status !== "active") {
    return false;
  }

  if (!host.firebaseUid) {
    return false;
  }

  if (host.activeCallId) {
    return false;
  }

  const lastSeenMs = timestampToMilliseconds(
    host.lastSeenAt
  );

  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  const ageMs = Date.now() - lastSeenMs;

  return ageMs >= 0 && ageMs <= HOST_TIMEOUT_MS;
}

function hasPaidMinutes(user) {
  const minutes = Number(user.minutes);

  return (
    Number.isFinite(minutes) &&
    minutes > 0
  );
}

function validateUserForMatching(user) {
  if (user.verificationStatus !== "approved") {
    throw new Error(
      "Your account must be approved before you can start a call."
    );
  }

  if (!hasPaidMinutes(user)) {
    throw new Error(
      "You have no available minutes. Please buy minutes before starting a call."
    );
  }

  if (user.activeCallId) {
    throw new Error(
      "User already has an active call."
    );
  }
}

/*
|--------------------------------------------------------------------------
| MATCH USER TO HOST
|--------------------------------------------------------------------------
| This function reserves a host and creates a call session.
|
| It does NOT:
| - Credit free minutes.
| - Deduct customer minutes.
| - Start a billable timer.
| - Generate a video-room URL.
| - Calculate host earnings.
|
| Those operations must be handled by the relevant trusted services.
|--------------------------------------------------------------------------
*/

export async function matchUserToHost(userId) {
  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId.length > 256
  ) {
    throw new Error("A valid user ID is required.");
  }

  const normalizedUserId = userId.trim();
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
    .filter(isHostAvailable)
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
  | ATTEMPT ATOMIC RESERVATION
  |--------------------------------------------------------------------------
  | Availability can change after candidate discovery, so all critical
  | conditions are checked again inside each transaction.
  |--------------------------------------------------------------------------
  */

  for (const candidate of candidates) {
    const hostRef = hostsCollection.doc(candidate.id);
    const callRef = callsCollection.doc();

    try {
      const result = await db.runTransaction(
        async (transaction) => {
          /*
           * Read every document before performing writes.
           */
          const [userSnapshot, hostSnapshot] =
            await Promise.all([
              transaction.get(userRef),
              transaction.get(hostRef),
            ]);

          if (!userSnapshot.exists) {
            throw new Error("User not found.");
          }

          if (!hostSnapshot.exists) {
            return {
              matched: false,
              reason: "host_unavailable",
            };
          }

          const user = userSnapshot.data();
          const host = hostSnapshot.data();

          /*
           * Enforce customer eligibility inside the transaction.
           */
          validateUserForMatching(user);

          /*
           * The host may have gone offline or been reserved by
           * another customer since candidate discovery.
           */
          if (!isHostAvailable(host)) {
            return {
              matched: false,
              reason: "host_unavailable",
            };
          }

          const now = new Date();

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

            endReason: null,

            createdAt: now,
            updatedAt: now,
          };

          /*
           * Reserve the host and assign the user to the call
           * atomically with creating the call session.
           */
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
          };
        }
      );

      if (result.matched) {
        // Return only the host fields needed by the matching caller.
        // Never return the private link-code hash.
        const {
          linkCodeHash,
          ...safeHost
        } = candidate;

        return {
          matched: true,
          host: safeHost,
          call: {
            id: result.callId,
            ...result.call,
          },
          retry: false,
        };
      }

      // Another customer may have claimed this host. Try the next one.
      continue;
    } catch (error) {
      /*
       * Eligibility failures must not be mistaken for a lack of hosts.
       * Unexpected Firestore failures should be visible to the caller.
       */
      console.error(
        "Host matching transaction failed:",
        {
          hostId: candidate.id,
          error: error.message,
        }
      );

      throw error;
    }
  }

  return {
    matched: false,
    host: null,
    call: null,
    retry: true,
    reason: "hosts_became_unavailable",
  };
}
