import { db } from "../config/firebase.js";

const usersCollection = db.collection("users");

/*
|--------------------------------------------------------------------------
| GET USER BY TELEGRAM ID
|--------------------------------------------------------------------------
*/

export async function getUserByTelegramId(
  telegramId
) {
  const snapshot = await usersCollection
    .where(
      "telegramId",
      "==",
      String(telegramId)
    )
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
}

/*
|--------------------------------------------------------------------------
| CREATE USER
|--------------------------------------------------------------------------
*/

export async function createUser(
  telegramUser
) {
  const telegramId = String(
    telegramUser.id
  );

  const existingUser =
    await getUserByTelegramId(
      telegramId
    );

  if (existingUser) {
    return existingUser;
  }

  const now = new Date();

  const userData = {
    telegramId,

    username:
      telegramUser.username || null,

    firstName:
      telegramUser.first_name || "",

    lastName:
      telegramUser.last_name || "",

    profile: {
      displayName:
        [
          telegramUser.first_name,
          telegramUser.last_name,
        ]
          .filter(Boolean)
          .join(" ") ||
        "SA LIVE User",

      bio: "",
    },

    verificationStatus:
      "pending",

    verification: {
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    },

    /*
    |--------------------------------------------------------------------------
    | BALANCE
    |--------------------------------------------------------------------------
    */

    minutes: 0,

    /*
    |--------------------------------------------------------------------------
    | CALL STATE
    |--------------------------------------------------------------------------
    */

    activeCallId: null,

    /*
    |--------------------------------------------------------------------------
    | USER ROLE
    |--------------------------------------------------------------------------
    */

    role: "user",

    createdAt: now,

    updatedAt: now,
  };

  const docRef =
    await usersCollection.add(
      userData
    );

  return {
    id: docRef.id,
    ...userData,
  };
}

/*
|--------------------------------------------------------------------------
| GET OR CREATE USER
|--------------------------------------------------------------------------
*/

export async function getOrCreateUser(
  telegramUser
) {
  const existingUser =
    await getUserByTelegramId(
      telegramUser.id
    );

  if (existingUser) {
    return existingUser;
  }

  return createUser(
    telegramUser
  );
}

/*
|--------------------------------------------------------------------------
| SUBMIT VERIFICATION
|--------------------------------------------------------------------------
*/

export async function submitVerification(
  userId
) {
  const userRef =
    usersCollection.doc(userId);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "User not found."
    );
  }

  const user = snapshot.data();

  /*
  |--------------------------------------------------------------------------
  | Already approved
  |--------------------------------------------------------------------------
  */

  if (
    user.verificationStatus ===
    "approved"
  ) {
    return;
  }

  const now = new Date();

  await userRef.update({
    verificationStatus:
      "pending",

    "verification.submittedAt":
      now,

    "verification.reviewedAt":
      null,

    "verification.reviewedBy":
      null,

    "verification.rejectionReason":
      null,

    updatedAt: now,
  });
}

/*
|--------------------------------------------------------------------------
| APPROVE VERIFICATION
|--------------------------------------------------------------------------
*/

export async function approveVerification(
  userId,
  adminTelegramId
) {
  const userRef =
    usersCollection.doc(userId);

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      if (!snapshot.exists) {
        throw new Error(
          "User not found."
        );
      }

      const user =
        snapshot.data();

      /*
      |--------------------------------------------------------------------------
      | Prevent duplicate free minutes
      |--------------------------------------------------------------------------
      */

      if (
        user.verificationStatus ===
        "approved"
      ) {
        return {
          alreadyApproved: true,

          minutes:
            Number(
              user.minutes || 0
            ),
        };
      }

      const currentMinutes =
        Number(
          user.minutes || 0
        );

      const newMinutes =
        currentMinutes + 5;

      const now =
        new Date();

      transaction.update(
        userRef,
        {
          verificationStatus:
            "approved",

          minutes:
            newMinutes,

          "verification.reviewedAt":
            now,

          "verification.reviewedBy":
            String(
              adminTelegramId
            ),

          "verification.rejectionReason":
            null,

          updatedAt:
            now,
        }
      );

      return {
        alreadyApproved:
          false,

        minutes:
          newMinutes,
      };
    }
  );
}

/*
|--------------------------------------------------------------------------
| REJECT VERIFICATION
|--------------------------------------------------------------------------
*/

export async function rejectVerification(
  userId,
  adminTelegramId,
  reason =
    "Verification was not approved."
) {
  const userRef =
    usersCollection.doc(userId);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "User not found."
    );
  }

  await userRef.update({
    verificationStatus:
      "rejected",

    "verification.reviewedAt":
      new Date(),

    "verification.reviewedBy":
      String(
        adminTelegramId
      ),

    "verification.rejectionReason":
      reason,

    updatedAt:
      new Date(),
  });
}

/*
|--------------------------------------------------------------------------
| GET PENDING USERS
|--------------------------------------------------------------------------
*/

export async function getPendingUsers() {
  const snapshot =
    await usersCollection
      .where(
        "verificationStatus",
        "==",
        "pending"
      )
      .get();

  const users =
    snapshot.docs.map(
      (doc) => ({
        id: doc.id,
        ...doc.data(),
      })
    );

  /*
  |--------------------------------------------------------------------------
  | Sort oldest requests first
  |--------------------------------------------------------------------------
  */

  users.sort(
    (a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return (
        aTime - bTime
      );
    }
  );

  return users;
}

/*
|--------------------------------------------------------------------------
| GET BALANCE
|--------------------------------------------------------------------------
*/

export async function getUserMinutes(
  userId
) {
  const userRef =
    usersCollection.doc(userId);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "User not found."
    );
  }

  const user =
    snapshot.data();

  return Number(
    user.minutes || 0
  );
}

/*
|--------------------------------------------------------------------------
| ADD MINUTES
|--------------------------------------------------------------------------
*/

export async function addMinutes(
  userId,
  minutes
) {
  const amount =
    Number(minutes);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Minutes must be greater than zero."
    );
  }

  const userRef =
    usersCollection.doc(userId);

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      if (!snapshot.exists) {
        throw new Error(
          "User not found."
        );
      }

      const user =
        snapshot.data();

      const currentMinutes =
        Number(
          user.minutes || 0
        );

      const newMinutes =
        currentMinutes +
        amount;

      transaction.update(
        userRef,
        {
          minutes:
            newMinutes,

          updatedAt:
            new Date(),
        }
      );

      return newMinutes;
    }
  );
}

/*
|--------------------------------------------------------------------------
| DEDUCT MINUTES
|--------------------------------------------------------------------------
*/

export async function deductMinutes(
  userId,
  minutes
) {
  const amount =
    Number(minutes);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Minutes must be greater than zero."
    );
  }

  const userRef =
    usersCollection.doc(userId);

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          userRef
        );

      if (!snapshot.exists) {
        throw new Error(
          "User not found."
        );
      }

      const user =
        snapshot.data();

      const currentMinutes =
        Number(
          user.minutes || 0
        );

      if (
        currentMinutes <= 0
      ) {
        throw new Error(
          "User has no available minutes."
        );
      }

      const newMinutes =
        Math.max(
          0,
          currentMinutes -
            amount
        );

      transaction.update(
        userRef,
        {
          minutes:
            newMinutes,

          updatedAt:
            new Date(),
        }
      );

      return newMinutes;
    }
  );
}

// ============================================================
// PAYMENT EMAIL
// ============================================================

export async function updateUserPaymentEmail(
  userId,
  email
) {
  const userRef =
    usersCollection.doc(userId);

  await userRef.update({
    paymentEmail: email,
    updatedAt: new Date(),
  });

  return {
    success: true,
    email,
  };
}


// ============================================================
// PENDING PAYMENT PACKAGE
// ============================================================

export async function setPendingPaymentPackage(
  userId,
  packageId
) {
  const userRef =
    usersCollection.doc(userId);

  await userRef.update({
    pendingPaymentPackageId:
      packageId,

    updatedAt:
      new Date(),
  });

  return {
    success: true,
    packageId,
  };
}


// ============================================================
// CLEAR PENDING PAYMENT
// ============================================================

export async function clearPendingPayment(
  userId
) {
  const userRef =
    usersCollection.doc(userId);

  await userRef.update({
    pendingPaymentPackageId: null,
    updatedAt: new Date(),
  });

  return {
    success: true,
  };
}