
import "dotenv/config";

import express from "express";
import cors from "cors";

import hostRoutes from "./routes/hostRoutes.js";
import callRoutes from "./routes/callRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminManagementRoutes from "./routes/adminManagementRoutes.js";
import adminWithdrawalRoutes from "./routes/adminWithdrawalRoutes.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const isProduction = process.env.NODE_ENV === "production";

// ------------------------------------------------------------
// CORS CONFIGURATION
// ------------------------------------------------------------

function normalizeOrigin(value) {
  try {
    const url = new URL(value.trim());

    if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      throw new Error("Origin must use HTTPS.");
    }

    return url.origin;
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
}

const configuredOrigins = [
  ...new Set(
    (process.env.CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(normalizeOrigin)
  ),
];

if (isProduction && configuredOrigins.length === 0) {
  throw new Error(
    "CORS_ORIGINS must contain your production website origin."
  );
}

app.disable("x-powered-by");

// ------------------------------------------------------------
// SECURITY HEADERS
// ------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=()"
  );

  if (isProduction) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }

  next();
});

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------

app.use(
  cors({
    origin(origin, callback) {
      // Requests without Origin are commonly server-to-server.
      // This does not replace authentication or authorization.
      if (!origin) {
        return callback(null, true);
      }

      let normalizedOrigin;

      try {
        normalizedOrigin = new URL(origin).origin;
      } catch {
        const error = new Error("Invalid request origin.");
        error.status = 403;
        return callback(error);
      }

      if (configuredOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      const error = new Error("Origin not allowed by CORS.");
      error.status = 403;
      return callback(error);
    },

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],

    credentials: false,
    maxAge: 600,
  })
);

// ------------------------------------------------------------
// REQUEST PARSING
// ------------------------------------------------------------

app.use(express.json({
  limit: "100kb",
  strict: true,
}));

// ------------------------------------------------------------
// HEALTH ENDPOINTS
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    success: true,
    service: "SA LIVE API",
    message: "Backend is running.",
  });
});

app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    success: true,
    status: "healthy",
    service: "SA LIVE API",
    timestamp: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// WEBSITE API ROUTES
// ------------------------------------------------------------

app.use("/api/hosts", hostRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminManagementRoutes);
app.use("/api/admin/withdrawals", adminWithdrawalRoutes);
app.use("/api/calls", callRoutes);

// ------------------------------------------------------------
// UNKNOWN ENDPOINTS
// ------------------------------------------------------------

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

// ------------------------------------------------------------
// CENTRAL ERROR HANDLER
// ------------------------------------------------------------

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  let status = Number.isInteger(error.status)
    ? error.status
    : 500;

  if (error.type === "entity.parse.failed") {
    status = 400;
  } else if (error.type === "entity.too.large") {
    status = 413;
  }

  if (status >= 500) {
    console.error("SA LIVE API error:", error);
  } else if (status === 403) {
    console.warn("SA LIVE request rejected:", error.message);
  }

  return res.status(status).json({
    success: false,
    message:
      status >= 500
        ? "An unexpected server error occurred."
        : status === 413
          ? "Request body is too large."
          : error.message || "Request failed.",
  });
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`SA LIVE API running on port ${PORT}`);
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

// ------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ------------------------------------------------------------

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`${signal} received. Shutting down SA LIVE API.`);

  server.close((error) => {
    if (error) {
      console.error("Server shutdown error:", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
