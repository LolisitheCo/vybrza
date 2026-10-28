import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");
const callRoomsCollection = db.collection("callRooms");

export const HOST_TIMEOUT_MS = 45_000;
const TIME_ZONE = "Africa/Johannesburg";
const MAX_AVAILABILITY_SLOTS = 21;

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
    fail(400, "A public username is required.");
  }

  const username = value.trim();

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    fail(
      400,
      "Username must contain 3–32 letters, numbers, or underscores."
    );
  }

  return username;
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
    slot?.weekday ??
      slot?.day ??
      slot?.dayOfWeek
  );
}

function getSlotStart(slot) {
  return slot?.startTime ?? slot?.start;
}

function getSlotEnd(slot) {
  return slot?.endTime ?? slot?.end;
}

/**
 * Checks whether the host's configured schedule covers the current
 * South African day and time.
 *
 * Availability slots may use:
 * { weekday: "monday", startTime: "09:00", endTime: "17:00" }
 *
 * The day may also be supplied as "day", and times as "start"/"end".
 */
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

    if (!day || day !== current.weekday) return false;
    if (!validTime(start) || !validTime(end)) return false;
    if (start >= end) return false;

    // Start is inclusive; end is exclusive.
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

  const maxCustomers = Number(room.maxCustomers ?? 3);

  return (
    Number.isInteger(maxCustomers) &&
    maxCustomers > 0 &&
    customerIds.length < Math.min(maxCustomers, 3)
  );
}

/**
 * Determines whether a host should be shown as available.
 *
 * A legacy activeCallId blocks availability unless the host also has
 * a valid group room with an available customer seat.
 *
 * When a group room is needed, pass its data as the third argument.
 * Without that data, this function fails closed for activeCallId.
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

  if (host.activeCallId) {
    const hasJoinableGroupRoom =
      host.activeGroupRoomId &&
      groupRoom &&
      groupRoom.id === host.activeGroupRoomId &&
      roomHasCapacity(groupRoom, host.id);

    if (!hasJoinableGroupRoom) return false;
  }

  if (host.activeGroupRoomId) {
    if (
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
 * Public directory.
 *
 * Only safe public profile fields are returned. Firebase UIDs,
 * email addresses, Telegram IDs, and private account data are omitted.
 */
export async function getPublicHostDirectory() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const hosts = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  // Read room documents for hosts that currently reference a group room.
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
      } catch {
        // Fail closed: if room status cannot be verified,
        // do not advertise the host as available.
        return [host.id, null];
      }
    })
  );

  const roomByHostId = new Map(roomResults);

  return hosts
    .map((host) => {
      const room = roomByHostId.get(host.id) ?? null;
      const online = isHostOnline(host, new Date(), room);

      const username =
        host.publicUsername ||
        host.username ||
        "";

      return {
        id: host.id,
        username,
        displayName:
          host.displayName ||
          host.name ||
          "SA LIVE Host",
        photoURL:
          host.photoURL ||
          host.profilePicture ||
          null,
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
        maxGroupCustomers: 3,
      };
    })
    .sort((a, b) =>
      Number(b.online) - Number(a.online)
    );
}

/**
 * Updates a host's public username, availability schedule,
 * and call-acceptance preference.
 *
 * Expected input:
 * { hostId, firebaseUid, username, availability, acceptingCalls }
 *
 * The caller must already authenticate the user. This service also
 * verifies that the host document belongs to the supplied Firebase UID.
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

  if (!Array.isArray(availability)) {
    fail(400, "Availability must be a list of schedule slots.");
  }

  if (availability.length > MAX_AVAILABILITY_SLOTS) {
    fail(
      400,
      `You can configure up to ${MAX_AVAILABILITY_SLOTS} availability slots.`
    );
  }

  if (typeof acceptingCalls !== "boolean") {
    fail(400, "acceptingCalls must be true or false.");
  }

  const normalizedUsername = normalizeUsername(username);

  const normalizedAvailability = availability.map((slot) => {
    if (!slot || typeof slot !== "object") {
      fail(400, "Each availability slot must be an object.");
    }

    const weekday = getSlotDay(slot);
    const startTime = getSlotStart(slot);
    const endTime = getSlotEnd(slot);

    const validDays = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];

    if (!validDays.includes(weekday)) {
      fail(400, "Each schedule slot needs a valid weekday.");
    }

    if (
      !validTime(startTime) ||
      !validTime(endTime) ||
      startTime >= endTime
    ) {
      fail(
        400,
        "Each schedule slot needs valid start and end times, with the end after the start."
      );
    }

    return {
      weekday,
      startTime,
      endTime,
    };
  });

  const usernameLower = normalizedUsername.toLowerCase();
  const hostRef = hostsCollection.doc(hostId);

  // Check username uniqueness across other active host records.
  const [usernameMatches, publicUsernameMatches] = await Promise.all([
    hostsCollection
      .where("usernameLower", "==", usernameLower)
      .limit(20)
      .get(),
    hostsCollection
      .where("publicUsernameLower", "==", usernameLower)
      .limit(20)
      .get(),
  ]);

  const conflict = [
    ...usernameMatches.docs,
    ...publicUsernameMatches.docs,
  ].some((doc) => doc.id !== hostId);

  if (conflict) {
    fail(409, "That username is already in use.");
  }

  return db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      fail(404, "Host account not found.");
    }

    const host = hostSnapshot.data();

    if (host.firebaseUid !== firebaseUid) {
      fail(403, "You are not authorized to update this host profile.");
    }

    if (host.status !== "active") {
      fail(403, "Only active hosts can update availability.");
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