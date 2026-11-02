
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const callRoomsCollection = db.collection("callRooms");

export const HOST_TIMEOUT_MS = 45_000;
export const MAX_GROUP_CUSTOMERS = 3;

const TIME_ZONE = "Africa/Johannesburg";
const MAX_AVAILABILITY_SLOTS = 21;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAY_ALIASES = {
  sun: "sunday",
  sunday: "sunday",
  mon: "monday",
  monday: "monday",
  tue: "tuesday",
  tues: "tuesday",
  tuesday: "tuesday",
  wed: "wednesday",
  wednesday: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  thursday: "thursday",
  fri: "friday",
  friday: "friday",
  sat: "saturday",
  saturday: "saturday",
};

function normalizeId(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
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

function normalizeWeekday(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return WEEKDAYS[value] ?? null;
  }

  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();

  if (/^[0-6]$/.test(normalized)) {
    return WEEKDAYS[Number(normalized)];
  }

  return WEEKDAY_ALIASES[normalized] ?? null;
}

function normalizeTime(value) {
  if (typeof value !== "string") return null;

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    value.trim()
  );

  if (!match) return null;

  return `${match[1]}:${match[2]}`;
}

function normalizeAvailability(availability) {
  if (!Array.isArray(availability)) {
    throw new Error("Availability must be an array.");
  }

  if (availability.length > MAX_AVAILABILITY_SLOTS) {
    throw new Error(
      `You can add a maximum of ${MAX_AVAILABILITY_SLOTS} availability slots.`
    );
  }

  const normalized = availability.map((slot) => {
    if (!slot || typeof slot !== "object") {
      throw new Error("Invalid availability slot.");
    }

    const weekday = normalizeWeekday(
      slot.weekday ?? slot.day ?? slot.dayOfWeek
    );

    const startTime = normalizeTime(
      slot.startTime ?? slot.start
    );

    const endTime = normalizeTime(
      slot.endTime ?? slot.end
    );

    if (!weekday || !startTime || !endTime) {
      throw new Error(
        "Each availability slot needs a valid weekday, start time and end time."
      );
    }

    if (startTime === endTime) {
      throw new Error(
        "Availability start and end times cannot be the same."
      );
    }

    return {
      weekday,
      startTime,
      endTime,
    };
  });

  const unique = new Set();

  for (const slot of normalized) {
    const key = `${slot.weekday}:${slot.startTime}:${slot.endTime}`;

    if (unique.has(key)) {
      throw new Error("Duplicate availability slots are not allowed.");
    }

    unique.add(key);
  }

  return normalized;
}

function getSouthAfricanTime(date = new Date()) {
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

export function isWithinHostSchedule(host, date = new Date()) {
  const availability = Array.isArray(host?.availability)
    ? host.availability
    : [];

  if (availability.length === 0) {
    return false;
  }

  const current = getSouthAfricanTime(date);
  const currentMinutes =
    Number(current.time.slice(0, 2)) * 60 +
    Number(current.time.slice(3, 5));

  return availability.some((slot) => {
    if (!slot || typeof slot !== "object") return false;

    const weekday = normalizeWeekday(
      slot.weekday ?? slot.day ?? slot.dayOfWeek
    );

    const startTime = normalizeTime(
      slot.startTime ?? slot.start
    );

    const endTime = normalizeTime(
      slot.endTime ?? slot.end
    );

    if (!weekday || !startTime || !endTime) {
      return false;
    }

    const startMinutes =
      Number(startTime.slice(0, 2)) * 60 +
      Number(startTime.slice(3, 5));

    const endMinutes =
      Number(endTime.slice(0, 2)) * 60 +
      Number(endTime.slice(3, 5));

    if (startMinutes < endMinutes) {
      return (
        weekday === current.weekday &&
        currentMinutes >= startMinutes &&
        currentMinutes < endMinutes
      );
    }

    // Overnight availability, for example 22:00–02:00.
    if (currentMinutes >= startMinutes) {
      return weekday === current.weekday;
    }

    if (currentMinutes < endMinutes) {
      const previousDay =
        WEEKDAYS[
          (WEEKDAYS.indexOf(current.weekday) + 6) % 7
        ];

      return weekday === previousDay;
    }

    return false;
  });
}

export function hasRecentHostHeartbeat(
  host,
  date = new Date()
) {
  const lastSeen = timestampMillis(host?.lastSeenAt);
  const age = date.getTime() - lastSeen;

  return (
    lastSeen > 0 &&
    age >= 0 &&
    age <= HOST_TIMEOUT_MS
  );
}

/**
 * Online means:
 * - host account is active;
 * - host is linked to Firebase Authentication;
 * - host has sent a recent heartbeat.
 *
 * Online does NOT mean accepting calls or currently available.
 */
export function isHostOnline(host, date = new Date()) {
  if (!host || host.status !== "active") {
    return false;
  }

  if (!normalizeId(host.firebaseUid)) {
    return false;
  }

  return hasRecentHostHeartbeat(host, date);
}

function roomHasCapacity(room, hostId) {
  if (!room || room.hostId !== hostId) {
    return false;
  }

  if (
    typeof room.roomName !== "string" ||
    !room.roomName.startsWith("salive-group-")
  ) {
    return false;
  }

  if (!["waiting_host", "active"].includes(room.status)) {
    return false;
  }

  if (room.endedAt) {
    return false;
  }

  const customerIds = Array.isArray(room.customerIds)
    ? room.customerIds
    : [];

  const configuredLimit = Number(
    room.maxCustomers ?? MAX_GROUP_CUSTOMERS
  );

  if (
    !Number.isInteger(configuredLimit) ||
    configuredLimit < 1
  ) {
    return false;
  }

  const limit = Math.min(
    configuredLimit,
    MAX_GROUP_CUSTOMERS
  );

  const uniqueCustomerIds = new Set(
    customerIds.filter(
      (id) => typeof id === "string" && id.trim()
    )
  );

  return uniqueCustomerIds.size < limit;
}

/**
 * Determines whether an online host can receive another
 * customer request.
 *
 * A host in a group room can receive another customer only
 * when the existing room has a free customer seat.
 */
export async function isHostAvailableForCalls(
  host,
  date = new Date()
) {
  if (!isHostOnline(host, date)) {
    return false;
  }

  if (host.acceptingCalls !== true) {
    return false;
  }

  if (!isWithinHostSchedule(host, date)) {
    return false;
  }

  const hostId = normalizeId(host.id);

  if (!hostId) return false;

  const groupRoomId = normalizeId(host.activeGroupRoomId);
  const activeCallId = normalizeId(host.activeCallId);

  if (groupRoomId) {
    const roomSnapshot = await callRoomsCollection
      .doc(groupRoomId)
      .get();

    if (!roomSnapshot.exists) {
      return false;
    }

    return roomHasCapacity(
      roomSnapshot.data(),
      hostId
    );
  }

  // A legacy one-to-one reservation cannot accept a second call.
  if (activeCallId) {
    return false;
  }

  return true;
}

/**
 * Returns the host's own editable availability profile.
 */
export async function getHostAvailabilityProfile(hostId) {
  const id = normalizeId(hostId);

  if (!id) {
    throw new Error("A valid host ID is required.");
  }

  const snapshot = await hostsCollection.doc(id).get();

  if (!snapshot.exists) {
    throw new Error("Host account not found.");
  }

  const host = snapshot.data();

  return {
    username: host.username ?? host.publicUsername ?? "",
    publicUsername:
      host.publicUsername ?? host.username ?? "",
    displayName: host.displayName ?? "",
    bio: host.bio ?? "",
    languages: Array.isArray(host.languages)
      ? host.languages
      : [],
    photoURL: host.photoURL ?? host.profilePicture ?? null,
    availability: Array.isArray(host.availability)
      ? host.availability
      : [],
    acceptingCalls: host.acceptingCalls === true,
    online: isHostOnline(
      { id: snapshot.id, ...host }
    ),
  };
}

/**
 * Public profile deliberately excludes private host fields.
 */
function getPublicHostProfile(host, online, available) {
  return {
    availability: Array.isArray(host.availability)
  ? host.availability
      .filter(
        (slot) =>
          slot &&
          typeof slot.weekday === "string" &&
          typeof slot.startTime === "string" &&
          typeof slot.endTime === "string"
      )
      .map((slot) => ({
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
      }))
  : [],
    id: host.id,
    displayName:
      host.displayName ||
      host.name ||
      host.publicUsername ||
      host.username ||
      "SA LIVE Host",
    username:
      host.publicUsername ||
      host.username ||
      null,
    photoURL:
      host.photoURL ||
      host.profilePicture ||
      null,
    bio:
      typeof host.bio === "string"
        ? host.bio.slice(0, 1000)
        : "",
    languages: Array.isArray(host.languages)
      ? host.languages.slice(0, 10)
      : [],
    online,
    available,
  };
}

/**
 * Public directory:
 * Online status is independent of acceptingCalls and schedule.
 *
 * Offline hosts are not included. Online hosts can appear even
 * when they are not currently accepting call requests.
 */
export async function getPublicHostDirectory() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const now = new Date();
  const hosts = [];

  for (const doc of snapshot.docs) {
    const host = {
      id: doc.id,
      ...doc.data(),
    };

    const online = isHostOnline(host, now);

    if (!online) {
      continue;
    }

    let available = false;

    try {
      available = await isHostAvailableForCalls(
        host,
        now
      );
    } catch (error) {
      console.error(
        "Host availability check failed:",
        doc.id,
        error?.code || "UNKNOWN_ERROR"
      );
    }

    hosts.push(
      getPublicHostProfile(host, online, available)
    );
  }

  hosts.sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }

    return a.displayName.localeCompare(b.displayName);
  });

  return hosts;
}

/**
 * Updates the authenticated host's public profile and
 * call availability settings.
 */
export async function updateHostAvailabilityProfile({
  hostId,
  firebaseUid,
  username,
  availability,
  acceptingCalls,
}) {
  const id = normalizeId(hostId);
  const uid = normalizeId(firebaseUid);

  if (!id || !uid) {
    throw new Error("Host authentication is required.");
  }

  if (
    typeof username !== "string" ||
    username.trim().length < 3 ||
    username.trim().length > 30
  ) {
    throw new Error(
      "Username must be between 3 and 30 characters."
    );
  }

  const cleanUsername = username
    .trim()
    .replace(/^@/, "");

  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    throw new Error(
      "Username can only contain letters, numbers and underscores."
    );
  }

  if (typeof acceptingCalls !== "boolean") {
    throw new Error(
      "Accepting calls must be true or false."
    );
  }

  const normalizedAvailability =
    normalizeAvailability(availability);

  const usernameLower = cleanUsername.toLowerCase();
  const hostRef = hostsCollection.doc(id);

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw new Error("Host account not found.");
    }

    const host = hostSnapshot.data();

    if (
      host.firebaseUid !== uid ||
      host.status !== "active"
    ) {
      throw new Error(
        "You are not authorized to update this host profile."
      );
    }

    const usernameQuery = hostsCollection
      .where("usernameLower", "==", usernameLower)
      .limit(2);

    const publicUsernameQuery = hostsCollection
      .where("publicUsernameLower", "==", usernameLower)
      .limit(2);

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
      if (matchingId !== id) {
        throw new Error(
          "That username is already in use."
        );
      }
    }

    const now = new Date();

    transaction.update(hostRef, {
      username: cleanUsername,
      usernameLower,
      publicUsername: cleanUsername,
      publicUsernameLower: usernameLower,
      availability: normalizedAvailability,
      acceptingCalls,
      updatedAt: now,
    });
  });

  return getHostAvailabilityProfile(id);
}
