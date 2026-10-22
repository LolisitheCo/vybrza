
import { db } from "../config/firebase.js";

const hostsCollection = db.collection("hosts");

const HOST_TIMEOUT_MS = 45_000;
const TIME_ZONE = "Africa/Johannesburg";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function getMillis(value) {
  if (value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string" || typeof value === "number") {
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : NaN;
  }

  return NaN;
}

function validateUsername(value) {
  if (typeof value !== "string") {
    throw new Error("Enter a public username.");
  }

  const username = value.trim();

  if (
    username.length < 3 ||
    username.length > 32 ||
    !/^[a-zA-Z0-9_]+$/.test(username)
  ) {
    throw new Error(
      "Username must be 3–32 characters and contain only letters, numbers, or underscores."
    );
  }

  return username;
}

function validateAvailability(value) {
  if (!Array.isArray(value) || value.length > 21) {
    throw new Error("Invalid availability schedule.");
  }

  return value.map((slot) => {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      throw new Error("Invalid availability entry.");
    }

    const { day, startTime, endTime } = slot;

    if (!DAYS.includes(day)) {
      throw new Error("Choose a valid day.");
    }

    if (
      typeof startTime !== "string" ||
      typeof endTime !== "string" ||
      !TIME_PATTERN.test(startTime) ||
      !TIME_PATTERN.test(endTime) ||
      startTime >= endTime
    ) {
      throw new Error(
        "Each time slot must have a valid start and end time on the same day."
      );
    }

    return { day, startTime, endTime };
  });
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
    day: values.weekday,
    time: `${values.hour}:${values.minute}`,
  };
}

function isRecentlySeen(host, nowMs) {
  const lastSeenMs = getMillis(host?.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  const age = nowMs - lastSeenMs;

  return age >= 0 && age <= HOST_TIMEOUT_MS;
}

function sanitizeAvailability(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((slot) => {
      return (
        slot &&
        typeof slot === "object" &&
        !Array.isArray(slot) &&
        DAYS.includes(slot.day) &&
        typeof slot.startTime === "string" &&
        typeof slot.endTime === "string" &&
        TIME_PATTERN.test(slot.startTime) &&
        TIME_PATTERN.test(slot.endTime) &&
        slot.startTime < slot.endTime
      );
    })
    .map(({ day, startTime, endTime }) => ({
      day,
      startTime,
      endTime,
    }));
}

/*
|--------------------------------------------------------------------------
| SHARED SCHEDULE CHECK
|--------------------------------------------------------------------------
| All schedule times use Africa/Johannesburg.
| Start time is inclusive; end time is exclusive.
|--------------------------------------------------------------------------
*/

export function isWithinHostSchedule(host, date = new Date()) {
  if (
    !host ||
    !Array.isArray(host.availability) ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime())
  ) {
    return false;
  }

  const { day, time } = getSouthAfricanDayAndTime(date);

  return host.availability.some((slot) => {
    if (
      !slot ||
      slot.day !== day ||
      typeof slot.startTime !== "string" ||
      typeof slot.endTime !== "string" ||
      !TIME_PATTERN.test(slot.startTime) ||
      !TIME_PATTERN.test(slot.endTime) ||
      slot.startTime >= slot.endTime
    ) {
      return false;
    }

    return time >= slot.startTime && time < slot.endTime;
  });
}

/*
|--------------------------------------------------------------------------
| SHARED DIRECTORY ONLINE CHECK
|--------------------------------------------------------------------------
*/

function isHostOnline(host, date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return false;
  }

  return Boolean(
    host &&
      host.status === "active" &&
      typeof host.firebaseUid === "string" &&
      host.firebaseUid.trim() &&
      host.acceptingCalls === true &&
      !host.activeCallId &&
      isRecentlySeen(host, date.getTime()) &&
      isWithinHostSchedule(host, date)
  );
}

/*
|--------------------------------------------------------------------------
| GET HOST AVAILABILITY PROFILE
|--------------------------------------------------------------------------
| This profile is returned only to the authenticated host.
|--------------------------------------------------------------------------
*/

export async function getHostAvailabilityProfile(hostId) {
  const snapshot = await hostsCollection.doc(hostId).get();

  if (!snapshot.exists) {
    throw new Error("Host account not found.");
  }

  const host = snapshot.data();

  return {
    id: snapshot.id,
    publicUsername: host.publicUsername || "",
    acceptingCalls: host.acceptingCalls === true,
    availability: sanitizeAvailability(host.availability),
    accountStatus: host.status,
  };
}

/*
|--------------------------------------------------------------------------
| UPDATE HOST AVAILABILITY PROFILE
|--------------------------------------------------------------------------
*/

export async function updateHostAvailabilityProfile(hostId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid profile details.");
  }

  const publicUsername = validateUsername(input.publicUsername);
  const availability = validateAvailability(input.availability);

  if (typeof input.acceptingCalls !== "boolean") {
    throw new Error("Choose whether you want to accept calls.");
  }

  const hostRef = hostsCollection.doc(hostId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(hostRef);

    if (!snapshot.exists) {
      throw new Error("Host account not found.");
    }

    const host = snapshot.data();

    if (host.status !== "active" || !host.firebaseUid) {
      throw new Error("An active, linked host account is required.");
    }

    transaction.update(hostRef, {
      publicUsername,
      availability,
      acceptingCalls: input.acceptingCalls,
      updatedAt: new Date(),
    });
  });

  return getHostAvailabilityProfile(hostId);
}

/*
|--------------------------------------------------------------------------
| PUBLIC HOST DIRECTORY
|--------------------------------------------------------------------------
| Only approved, linked hosts with a public username are included.
| The response contains only explicitly selected public fields.
| Never return Telegram IDs, Firebase UIDs, email addresses,
| bank details, internal call IDs, or raw host documents.
|--------------------------------------------------------------------------
*/

export async function getPublicHostDirectory() {
  const snapshot = await hostsCollection
    .where("status", "==", "active")
    .get();

  const now = new Date();

  return snapshot.docs
    .map((doc) => {
      const host = doc.data();

      if (
        typeof host.firebaseUid !== "string" ||
        !host.firebaseUid.trim() ||
        typeof host.publicUsername !== "string" ||
        !host.publicUsername.trim()
      ) {
        return null;
      }

      const username = host.publicUsername.trim();
      const online = isHostOnline(host, now);

      return {
        // Public, non-sensitive identifier.
        // The username is already displayed publicly.
        id: username.toLowerCase(),
        username,
        displayName: username,
        online,
        status: online ? "online" : "offline",
        availability: sanitizeAvailability(host.availability),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.username.localeCompare(b.username));
}
