import { db } from "../config/firebase.js";

const usersCollection =
  db.collection("users");

const hostsCollection =
  db.collection("hosts");

const callsCollection =
  db.collection("callSessions");

/*
|--------------------------------------------------------------------------
| HOST TIMEOUT
|--------------------------------------------------------------------------
|
| A host must have sent a heartbeat recently.
|
*/

const HOST_TIMEOUT_SECONDS = 45;

/*
|--------------------------------------------------------------------------
| CHECK HOST AVAILABILITY
|--------------------------------------------------------------------------
*/

function isHostAvailable(host) {
  if (
    host.status !== "active"
  ) {
    return false;
  }

  if (host.activeCallId) {
    return false;
  }

  if (!host.lastSeenAt) {
    return false;
  }

  const lastSeen =
    host.lastSeenAt.toDate
      ? host.lastSeenAt.toDate()
      : new Date(
          host.lastSeenAt
        );

  const ageSeconds =
    (Date.now() -
      lastSeen.getTime()) /
    1000;

  return (
    ageSeconds <=
    HOST_TIMEOUT_SECONDS
  );
}

/*
|--------------------------------------------------------------------------
| MATCH USER TO HOST
|--------------------------------------------------------------------------
*/

export async function matchUserToHost(
  userId
) {
  /*
  |--------------------------------------------------------------------------
  | Get active hosts
  |--------------------------------------------------------------------------
  */

  const hostSnapshot =
    await hostsCollection
      .where(
        "status",
        "==",
        "active"
      )
      .get();

  if (
    hostSnapshot.empty
  ) {
    return {
      matched: false,
      host: null,
      call: null,
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Find a recently active host
  |--------------------------------------------------------------------------
  */

  let selectedHost = null;

  for (
    const doc of hostSnapshot.docs
  ) {
    const host = {
      id: doc.id,
      ...doc.data(),
    };

    if (
      isHostAvailable(host)
    ) {
      selectedHost = host;
      break;
    }
  }

  if (!selectedHost) {
    return {
      matched: false,
      host: null,
      call: null,
    };
  }

  /*
  |--------------------------------------------------------------------------
  | References
  |--------------------------------------------------------------------------
  */

  const userRef =
    usersCollection.doc(
      userId
    );

  const hostRef =
    hostsCollection.doc(
      selectedHost.id
    );

  const callRef =
    callsCollection.doc();

  /*
  |--------------------------------------------------------------------------
  | ATOMIC MATCH
  |--------------------------------------------------------------------------
  |
  | The host reservation and user
  | active-call assignment happen
  | in the same Firestore transaction.
  |
  */

  try {
    const result =
      await db.runTransaction(
        async (transaction) => {
          /*
          |--------------------------------------------------------------------------
          | Read current state
          |--------------------------------------------------------------------------
          */

          const userSnapshot =
            await transaction.get(
              userRef
            );

          const hostSnapshot =
            await transaction.get(
              hostRef
            );

          if (
            !userSnapshot.exists
          ) {
            throw new Error(
              "User not found."
            );
          }

          if (
            !hostSnapshot.exists
          ) {
            throw new Error(
              "Host no longer exists."
            );
          }

          const user =
            userSnapshot.data();

          const host =
            hostSnapshot.data();

          /*
          |--------------------------------------------------------------------------
          | Make sure user isn't already
          | in another call
          |--------------------------------------------------------------------------
          */

          if (
            user.activeCallId
          ) {
            throw new Error(
              "User already has an active call."
            );
          }

          /*
          |--------------------------------------------------------------------------
          | Re-check host availability
          |--------------------------------------------------------------------------
          */

          if (
            !isHostAvailable(
              host
            )
          ) {
            throw new Error(
              "Host is no longer available."
            );
          }

          /*
          |--------------------------------------------------------------------------
          | Create call
          |--------------------------------------------------------------------------
          */

          const now =
            new Date();

          const callData = {
            userId,

            hostId:
              selectedHost.id,

            status:
              "matched",

            roomId: null,

            roomUrl: null,

            startedAt: null,

            endedAt: null,

            durationSeconds: 0,

            minutesUsed: 0,

            endReason: null,

            createdAt:
              now,

            updatedAt:
              now,
          };

          /*
          |--------------------------------------------------------------------------
          | Reserve host
          |--------------------------------------------------------------------------
          */

          transaction.update(
            hostRef,
            {
              activeCallId:
                callRef.id,

              updatedAt:
                now,
            }
          );

          /*
          |--------------------------------------------------------------------------
          | Assign call to user
          |--------------------------------------------------------------------------
          */

          transaction.update(
            userRef,
            {
              activeCallId:
                callRef.id,

              updatedAt:
                now,
            }
          );

          /*
          |--------------------------------------------------------------------------
          | Create call session
          |--------------------------------------------------------------------------
          */

          transaction.set(
            callRef,
            callData
          );

          return {
            callId:
              callRef.id,

            call:
              callData,
          };
        }
      );

    return {
      matched: true,

      host: selectedHost,

      call: {
        id:
          result.callId,

        ...result.call,
      },
    };
  } catch (error) {
    console.error(
      "Host matching transaction failed:",
      error
    );

    return {
      matched: false,

      host: null,

      call: null,

      retry: true,
    };
  }
}