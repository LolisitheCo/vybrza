
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const callRoomsCollection = db.collection("callRooms");

export const HOST_TIMEOUT_MS = 45_000;

const TIME_ZONE = "Africa/Johannesburg";
const MAX_AVAILABILITY_SLOTS = 21;
const MAX_GROUP_CUSTOMERS = 2;

const VALID_DAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

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

function normalizeUsername(value) {
  if (typeof value !== "string") {
    fail(400, "Enter a public username.");
  }

  const username = value.trim();

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    fail(
      400,
      "Username must be 3–32 characters and contain only letters, numbers, or underscores."
    );
  }

  return username;
}

function normalizeDay(value) {
  if (typeof value !== "string") return "";

  const day = value.trim().toLowerCase();

  const aliases = {
    mon: "monday",
    tue: "tuesday",
    tues: "tuesday",
    wed: "wednesday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    fri: "friday",
    sat: "saturday",
    sun: "sunday",
  };

  return aliases[day] || day;
}

function validTime(value) {
  return (
    typeof value === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  );
}

function getSlotDay(slot) {
  return normalizeDay(
    slot?.weekday ?? slot?.day ?? slot?.dayOfWeek
  );
}

function getSlotStart(slot) {
  return slot?.startTime ?? slot?.start;
}

function getSlotEnd(slot) {
  return slot?.endTime ?? slot?.end;
}

function getSouthAfricanDayAndTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return {
    weekday: values.weekday.toLowerCase(),
    time: `${values.hour}:${values.minute}`,
  };
}

function normalizeAvailability(availability) {
  if (!Array.isArray(availability)) {
    fail(400, "Invalid availability schedule.");
  }

  if (availability.length > MAX_AVAILABILITY_SLOTS) {
    fail(
      400,
      `You can configure up to ${MAX_AVAILABILITY_SLOTS} availability slots.`
    );
  }

  return availability.map((slot) => {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      fail(400, "Invalid availability entry.");
    }

    const weekday = getSlotDay(slot);
    const startTime = getSlotStart(slot);
    const endTime = getSlotEnd(slot);

    if (!VALID_DAYS.has(weekday)) {
      fail(400, "Choose a valid day.");
    }

    if (
      !validTime(startTime) ||
      !validTime(endTime) ||
      startTime >= endTime
    ) {
      fail(
        400,
        "Each time slot must have a valid start and end time on the same day."
      );
    }

    return {
      weekday,
      startTime,
      endTime,
    };
  });
}

export function isWithinHostSchedule(
  host,
  date = new Date()
) {
  const availability = host?.availability;

  if (!Array.isArray(availability) || availability.length === 0) {
    return false;
  }

  const current = getSouthAfricanDayAndTime(date);

  return availability.some((slot) => {
    if (!slot || typeof slot !== "object") return false;

    const day = getSlotDay(slot);
    const start = getSlotStart(slot);
    const end = getSlotEnd(slot);

    if (day !== current.weekday) return false;
    if (!validTime(start) || !validTime(end)) return false;
    if (start >= end) return false;

    return current.time >= start && current.time < end;
  });
}

function hasRecentHeartbeat(host, date = new Date()) {
  const lastSeen = timestampMillis(host?.lastSeenAt);
  const age = date.getTime() - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
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

  const configuredLimit = Number(room.maxCustomers ?? MAX_GROUP_CUSTOMERS);

  if (!Number.isInteger(configuredLimit) || configuredLimit < 1) {
    return false;
  }

  return customerIds.length < Math.min(
    configuredLimit,
    MAX_GROUP_CUSTOMERS
  );
}

/**
 * Determines whether a host is available.
 *
 * A group room is only considered joinable when its ownership,
 * status and remaining capacity can be verified.
 */
export function isHostOnline(
  host,
  date = new Date(),
  groupRoom = null
) {
  if (!host || host.status !== "active") return false;
  if (!host.firebaseUid) return false;
  if (host.acceptingCalls !== true) return false;
  if (!hasRecentHeartbeat(host, date)) return false;
  if (!isWithinHostSchedule(host, date)) return false;

  if (host.activeCallId || host.activeGroupRoomId) {
    if (
      !host.activeGroupRoomId ||
      !groupRoom ||
      groupRoom.id !== host.activeGroupRoomId ||
      !roomHasCapacity(groupRoom, host.id)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Returns the authenticated host's editable public profile.
 * Private account fields are deliberately excluded.
 */
export async function getHostAvailabilityProfile(hostId) {
  if (typeof hostId !== "string" || !hostId.trim()) {
    fail(400, "A valid host ID is required.");
  }

  const snapshot = await hostsCollection.doc(hostId).get();

  if (!snapshot.exists) {
    fail(404, "Host profile not found.");
  }

  const host = snapshot.data();

  return {
    id: snapshot.id,
    username: host.publicUsername || host.username || "",
    displayName: host.displayName || host.name || "",
    photoURL: host.photoURL || host.profilePicture || null,
    bio: host.bio || "",
    languages: Array.isArray(host.languages) ? host.languages : [],
    availability: Array.isArray(host.availability)
      ? host.availability
      : [],
    acceptingCalls: host.acceptingCalls === true,
    status: host.status || "inactive",
  };
}

/**
 * Returns only safe public host directory information.
 */
export async function getPublicHostDirectory() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const hosts = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  const roomResults = await Promise.all(
    hosts.map(async (host) => {
      if (!host.activeGroupRoomId) {
        return [host.id, null];
      }

      try {
        const roomSnapshot = await callRoomsCollection
          .doc(host.activeGroupRoomId)
          .get();

        if (!roomSnapshot.exists) {
          return [host.id, null];
        }

        return [
          host.id,
          {
            id: roomSnapshot.id,
            ...roomSnapshot.data(),
          },
        ];
      } catch (error) {
        console.error(
          "Unable to verify host group room:",
          host.id,
          error.message
        );

        return [host.id, null];
      }
    })
  );

  const roomByHostId = new Map(roomResults);
  const now = new Date();

  return hosts
    .map((host) => {
      const room = roomByHostId.get(host.id) ?? null;
      const online = isHostOnline(host, now, room);

      return {
        id: host.id,
        username: host.publicUsername || host.username || "",
        displayName:
          host.displayName || host.name || "SA LIVE Host",
        photoURL:
          host.photoURL || host.profilePicture || null,
        bio: host.bio || "",
        languages: Array.isArray(host.languages)
          ? host.languages
          : [],
        online,
        status: online ? "online" : "offline",
        acceptingCalls: host.acceptingCalls === true,
        availability: Array.isArray(host.availability)
          ? host.availability
          : [],
        groupRoomAvailable: Boolean(
          room && roomHasCapacity(room, host.id)
        ),
        groupCustomerCount: room
          ? (
              Array.isArray(room.customerIds)
                ? room.customerIds.length
                : 0
            )
          : 0,
        maxGroupCustomers: MAX_GROUP_CUSTOMERS,
      };
    })
    .sort((a, b) => Number(b.online) - Number(a.online));
}

/**
 * Updates an authenticated host's username and availability.
 *
 * Expected arguments:
 * {
 *   hostId,
 *   firebaseUid,
 *   username,
 *   availability,
 *   acceptingCalls
 * }
 */
export async function updateHostAvailabilityProfile({
  hostId,
  firebaseUid,
  username,
  availability,
  acceptingCalls,
}) {
  if (
    typeof hostId !== "string" ||
    !hostId.trim() ||
    typeof firebaseUid !== "string" ||
    !firebaseUid.trim()
  ) {
    fail(400, "A valid host ID and Firebase UID are required.");
  }

  const normalizedUsername = normalizeUsername(username);
  const normalizedAvailability = normalizeAvailability(availability);

  if (typeof acceptingCalls !== "boolean") {
    fail(400, "Choose whether you want to accept calls.");
  }

  const usernameLower = normalizedUsername.toLowerCase();
  const hostRef = hostsCollection.doc(hostId);

  return db.runTransaction(async (transaction) => {
    // All reads must happen before transaction writes.
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      fail(404, "Host account not found.");
    }

    const host = hostSnapshot.data();

    if (host.firebaseUid !== firebaseUid) {
      fail(403, "You are not authorized to update this host profile.");
    }

    if (host.status !== "active") {
      fail(403, "Host account is not active.");
    }

    const usernameQuery = hostsCollection
      .where("usernameLower", "==", usernameLower)
      .limit(20);

    const publicUsernameQuery = hostsCollection
      .where("publicUsernameLower", "==", usernameLower)
      .limit(20);

    const [usernameMatches, publicUsernameMatches] =
      await Promise.all([
        transaction.get(usernameQuery),
        transaction.get(publicUsernameQuery),
      ]);

    const matchingIds = new Set([
      ...usernameMatches.docs.map((doc) => doc.id),
      ...publicUsernameMatches.docs.map((doc) => doc.id),
    ]);

    for (const matchingId of matchingIds) {
      if (matchingId !== hostId) {
        fail(409, "That host username is already in use.");
      }
    }

    const now = new Date();

    transaction.update(hostRef, {
      username: normalizedUsername,
      usernameLower,
      publicUsername: normalizedUsername,
      publicUsernameLower: usernameLower,
      availability: normalizedAvailability,
      acceptingCalls,
      updatedAt: now,
    });

    return {
      id: hostId,
      username: normalizedUsername,
      availability: normalizedAvailability,
      acceptingCalls,
      updatedAt: now,
    };
  });
}
