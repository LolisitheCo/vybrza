
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

const MAX_AVAILABILITY_SLOTS = 21;

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

function validateHostId(hostId) {
  if (
    typeof hostId !== "string" ||
    !hostId.trim() ||
    hostId.trim().length > 150 ||
    hostId.includes("/")
  ) {
    throw makeError("Invalid host account identifier.");
  }

  return hostId.trim();
}

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

    return Number.isFinite(milliseconds)
      ? milliseconds
      : NaN;
  }

  return NaN;
}

function validateUsername(value) {
  if (typeof value !== "string") {
    throw makeError("Enter a public username.");
  }

  const username = value.trim();

  if (
    username.length < 3 ||
    username.length > 32 ||
    !/^[a-zA-Z0-9_]+$/.test(username)
  ) {
    throw makeError(
      "Username must be 3–32 characters and contain only letters, numbers, or underscores."
    );
  }

  return username;
}

function validateAvailability(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_AVAILABILITY_SLOTS
  ) {
    throw makeError("Invalid availability schedule.");
  }

  const slots = value.map((slot) => {
    if (
      !slot ||
      typeof slot !== "object" ||
      Array.isArray(slot)
    ) {
      throw makeError("Invalid availability entry.");
    }

    const { day, startTime, endTime } = slot;

    if (!DAYS.includes(day)) {
      throw makeError("Choose a valid day.");
    }

    if (
      typeof startTime !== "string" ||
      typeof endTime !== "string" ||
      !TIME_PATTERN.test(startTime) ||
      !TIME_PATTERN.test(endTime) ||
      startTime >= endTime
    ) {
      throw makeError(
        "Each time slot must have a valid start and end time on the same day."
      );
    }

    return { day, startTime, endTime };
  });

  // Reject duplicate and overlapping slots on the same day.
  const slotsByDay = new Map();

  for (const slot of slots) {
    if (!slotsByDay.has(slot.day)) {
      slotsByDay.set(slot.day, []);
    }

    slotsByDay.get(slot.day).push(slot);
  }

  for (const daySlots of slotsByDay.values()) {
    daySlots.sort((a, b) =>
      a.startTime.localeCompare(b.startTime)
    );

    for (let index = 1; index < daySlots.length; index += 1) {
      if (
        daySlots[index].startTime <
        daySlots[index - 1].endTime
      ) {
        throw makeError(
          "Availability slots on the same day cannot overlap."
        );
      }
    }
  }

  return slots;
}

function sanitizeAvailability(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  try {
    return validateAvailability(value);
  } catch {
    // Do not expose malformed stored schedule entries.
    return [];
  }
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

function isValidSlot(slot) {
  return Boolean(
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
}

function isHostOnline(host, date = new Date()) {
  if (
    !host ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime())
  ) {
    return false;
  }

  return Boolean(
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
| SHARED SCHEDULE CHECK
|--------------------------------------------------------------------------
| Schedule times use Africa/Johannesburg.
| Start is inclusive; end is exclusive.
|--------------------------------------------------------------------------
*/

export function isWithinHostSchedule(
  host,
  date = new Date()
) {
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
    if (!isValidSlot(slot) || slot.day !== day) {
      return false;
    }

    return time >= slot.startTime && time < slot.endTime;
  });
}

/*
|--------------------------------------------------------------------------
| GET HOST AVAILABILITY PROFILE
|--------------------------------------------------------------------------
| Intended for the authenticated host's own profile.
| Route middleware must verify host ownership.
|--------------------------------------------------------------------------
*/

export async function getHostAvailabilityProfile(hostId) {
  const safeHostId = validateHostId(hostId);

  const snapshot = await hostsCollection
    .doc(safeHostId)
    .get();

  if (!snapshot.exists) {
    throw makeError("Host account not found.", 404);
  }

  const host = snapshot.data();

  return {
    id: snapshot.id,
    publicUsername: host.publicUsername || "",
    acceptingCalls: host.acceptingCalls === true,
    availability: sanitizeAvailability(host.availability),
    accountStatus: host.status || "unknown",
  };
}

/*
|--------------------------------------------------------------------------
| UPDATE HOST AVAILABILITY PROFILE
|--------------------------------------------------------------------------
| Only public username, schedule and acceptingCalls are editable here.
| Account status, Firebase UID, earnings, and activeCallId cannot be
| changed through this function.
|--------------------------------------------------------------------------
*/

export async function updateHostAvailabilityProfile(
  hostId,
  input
) {
  const safeHostId = validateHostId(hostId);

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw makeError("Invalid profile details.");
  }

  const publicUsername = validateUsername(
    input.publicUsername
  );

  const usernameLower = publicUsername.toLowerCase();

  const availability = validateAvailability(
    input.availability
  );

  if (typeof input.acceptingCalls !== "boolean") {
    throw makeError(
      "Choose whether you want to accept calls."
    );
  }

  const hostRef = hostsCollection.doc(safeHostId);

  await db.runTransaction(async (transaction) => {
    const hostSnapshot = await transaction.get(hostRef);

    if (!hostSnapshot.exists) {
      throw makeError("Host account not found.", 404);
    }

    const host = hostSnapshot.data();

    if (
      host.status !== "active" ||
      typeof host.firebaseUid !== "string" ||
      !host.firebaseUid.trim()
    ) {
      throw makeError(
        "An active, linked host account is required.",
        403
      );
    }

    // Check both fields to remain compatible with older host records.
    const usernameQuery = hostsCollection
      .where("usernameLower", "==", usernameLower)
      .limit(10);

    const publicUsernameQuery = hostsCollection
      .where("publicUsernameLower", "==", usernameLower)
      .limit(10);

    const [
      usernameMatches,
      publicUsernameMatches,
    ] = await Promise.all([
      transaction.get(usernameQuery),
      transaction.get(publicUsernameQuery),
    ]);

    const conflictingIds = new Set([
      ...usernameMatches.docs.map((doc) => doc.id),
      ...publicUsernameMatches.docs.map((doc) => doc.id),
    ]);

    for (const conflictingId of conflictingIds) {
      if (conflictingId !== hostSnapshot.id) {
        throw makeError(
          "That host username is already in use.",
          409
        );
      }
    }

    transaction.update(hostRef, {
      username: publicUsername,
      usernameLower,
      publicUsername,
      publicUsernameLower: usernameLower,
      availability,
      acceptingCalls: input.acceptingCalls,
      updatedAt: new Date(),
    });
  });

  return getHostAvailabilityProfile(safeHostId);
}

/*
|--------------------------------------------------------------------------
| PUBLIC HOST DIRECTORY
|--------------------------------------------------------------------------
| Return an allowlist of public fields only.
| Do not return Firebase UIDs, email addresses, financial details,
| internal call IDs, or raw Firestore documents.
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
        // Public display identifier, not an authorization identifier.
        id: username.toLowerCase(),
        username,
        displayName:
          typeof host.displayName === "string" &&
          host.displayName.trim()
            ? host.displayName.trim()
            : username,
        online,
        status: online ? "online" : "offline",
        availability: sanitizeAvailability(host.availability),
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.username.localeCompare(b.username)
    );
}
