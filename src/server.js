
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

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

if (isProduction && configuredOrigins.length === 0) {
  throw new Error(
    "CORS_ORIGINS must contain your production website origin."
  );
}

if (isProduction && configuredOrigins.includes("*")) {
  throw new Error(
    "Wildcard CORS origins are not allowed in production."
  );
}

if (
  isProduction &&
  configuredOrigins.some((origin) => !origin.startsWith("https://"))
) {
  throw new Error(
    "Production CORS origins must use HTTPS."
  );
}

app.disable("x-powered-by");

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

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server requests without an Origin header.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (configuredOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      const error = new Error("Origin not allowed by CORS.");
      error.status = 403;
      return callback(error);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],
    credentials: false,
    maxAge: 600,
  })
);

app.use(express.json({ limit: "100kb", strict: true }));

app.get("/", (req, res) => {
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

// API routes.
app.use("/api/hosts", hostRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminManagementRoutes);
app.use("/api/admin/withdrawals", adminWithdrawalRoutes);
app.use("/api/calls", callRoutes);

// Unknown endpoints.
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

// Central error handler.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number.isInteger(error.status)
    ? error.status
    : error.type === "entity.parse.failed"
      ? 400
      : 500;

  if (status >= 500) {
    console.error("SA LIVE API error:", error);
  }

  return res.status(status).json({
    success: false,
    message:
      status >= 500
        ? "An unexpected server error occurred."
        : error.message || "Request failed.",
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`SA LIVE API running on port ${PORT}`);
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

function shutdown(signal) {
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
