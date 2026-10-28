import { db } from "../config/firebase.js";
import {
  matchCustomerToGroupRoom,
} from "./groupRoomService.js";

const usersCollection = db.collection("users");
const hostsCollection = db.collection("hosts");
const callSessionsCollection = db.collection("callSessions");
const callRoomsCollection = db.collection("callRooms");

const HOST_TIMEOUT_MS = 45_000;

function timestampMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function hasRecentHeartbeat(host) {
  const lastSeen = timestampMillis(host.lastSeenAt);
  const age = Date.now() - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);

  return Number.isSafeInteger(minutes) && minutes >= 0
    ? minutes
    : null;
}

function isTerminalCall(call) {
  if (!call) return true;

  if (call.endedAt) return true;

  return [
    "ended",
    "completed",
    "cancelled",
    "canceled",
    "failed",
  ].includes(String(call.status ?? "").toLowerCase());
}

function roomHasCapacity(room, hostId) {
  if (!room || room.hostId !== hostId) return false;

  if (
    typeof room.roomName !== "string" ||
    !room.roomName.startsWith("salive-group-")
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) return false;

  const customerIds = Array.isArray(room.customerIds)
    ? room.customerIds
    : [];

  const maxCustomers = Number(room.maxCustomers ?? 3);

  return (
    Number.isInteger(maxCustomers) &&
    maxCustomers > 0 &&
    customerIds.length < Math.min(maxCustomers, 3)
  );
}

/**
 * Validate that the customer has minutes and no active call.
 *
 * A dangling activeCallId is cleared only when the corresponding call
 * is missing or demonstrably terminal. An active call is never cleared
 * just to make matching succeed.
 */
export async function validateUserForMatching(userId) {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("A valid customer ID is required.");
  }

  const userRef = usersCollection.doc(userId);

  return db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);

    if (!userSnapshot.exists) {
      throw new Error("Customer account not found.");
    }

    const user = userSnapshot.data();
    const minutes = normalizeMinutes(user.minutes);

    if (minutes === null || minutes <= 0) {
      throw new Error(
        "You need available minutes before starting a call."
      );
    }

    if (!user.activeCallId) {
      return {
        ...user,
        id: userSnapshot.id,
        minutes,
      };
    }

    const callRef = callSessionsCollection.doc(user.activeCallId);
    const callSnapshot = await transaction.get(callRef);

    if (!callSnapshot.exists) {
      transaction.update(userRef, {
        activeCallId: null,
        updatedAt: new Date(),
      });

      return {
        ...user,
        id: userSnapshot.id,
        activeCallId: null,
        minutes,
      };
    }

    const call = callSnapshot.data();

    if (!isTerminalCall(call)) {
      throw new Error(
        "You already have a call in progress. End it before starting another."
      );
    }

    transaction.update(userRef, {
      activeCallId: null,
      updatedAt: new Date(),
    });

    return {
      ...user,
      id: userSnapshot.id,
      activeCallId: null,
      minutes,
    };
  });
}

/**
 * A host is eligible if active, linked, recently online, accepting calls,
 * scheduled now, and either has no existing reservation or has a group
 * room with space remaining.
 */
async function isHostAvailable(host, date = new Date()) {
  if (!host || host.status !== "active") return false;
  if (!host.firebaseUid) return false;
  if (host.acceptingCalls !== true) return false;
  if (!hasRecentHeartbeat(host)) return false;

  // Use the shared schedule checker. This keeps the directory and
  // matching rules aligned.
  const { isWithinHostSchedule } = await import(
    "./hostAvailabilityService.js"
  );

  if (!isWithinHostSchedule(host, date)) return false;

  if (!host.activeGroupRoomId) {
    // Legacy one-to-one reservation blocks new assignments.
    return !host.activeCallId;
  }

  const roomSnapshot = await callRoomsCollection
    .doc(host.activeGroupRoomId)
    .get();

  if (!roomSnapshot.exists) return false;

  const room = {
    id: roomSnapshot.id,
    ...roomSnapshot.data(),
  };

  if (!roomHasCapacity(room, host.id)) return false;

  // An active group room may coexist with a legacy activeCallId
  // pointer. The group service will still validate the room and host.
  return true;
}

/**
 * Match a customer to an available host or a group room with capacity.
 *
 * Returns the same match object produced by matchCustomerToGroupRoom.
 */
export async function matchUserToHost(userId) {
  await validateUserForMatching(userId);

  const hostsSnapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const candidates = hostsSnapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const host of candidates) {
    const available = await isHostAvailable(host);

    if (!available) continue;

    const result = await matchCustomerToGroupRoom({
      userId,
      hostId: host.id,
    });

    if (result.matched) {
      return result;
    }
  }

  return {
    matched: false,
    message:
      "No available host or group-room seat was found. Please try again shortly.",
    retry: true,
  };
}