
import "dotenv/config";

import express from "express";
import cors from "cors";

import { bot } from "./bot/bot.js";
import hostRoutes from "./routes/hostRoutes.js";
import callRoutes from "./routes/callRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminManagementRoutes from "./routes/adminManagementRoutes.js";

const app = express();

const PORT = Number.parseInt(process.env.PORT || "5000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

/*
|--------------------------------------------------------------------------
| PRODUCTION CONFIGURATION
|--------------------------------------------------------------------------
*/

const configuredOrigins = (
  process.env.CORS_ORIGINS || ""
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (
  IS_PRODUCTION &&
  configuredOrigins.some((origin) => origin === "*")
) {
  throw new Error(
    "Wildcard CORS origins are not permitted in production."
  );
}

for (const origin of configuredOrigins) {
  let parsed;

  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid CORS origin configured: ${origin}`);
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== origin
  ) {
    throw new Error(
      `CORS_ORIGINS must contain exact origins, not paths: ${origin}`
    );
  }

  if (IS_PRODUCTION && parsed.protocol !== "https:") {
    throw new Error(
      "Production CORS origins must use HTTPS."
    );
  }
}

/*
|--------------------------------------------------------------------------
| SECURITY HEADERS
|--------------------------------------------------------------------------
*/

app.disable("x-powered-by");

// Do not enable trust proxy globally without configuring the exact
// trusted proxy topology used by your hosting provider.
app.disable("etag");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (IS_PRODUCTION) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000"
    );
  }

  next();
});

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
| Set CORS_ORIGINS on Render to your exact frontend origin(s),
| separated by commas, for example:
|
| CORS_ORIGINS=https://your-frontend.example
|
| Requests without an Origin header are allowed through CORS because
| server-to-server clients such as PayFast ITN may not send one.
| CORS is NOT authentication and does not replace route authorization.
|--------------------------------------------------------------------------
*/

const corsOptions = {
  origin(origin, callback) {
    // Non-browser clients may omit Origin. This does not authenticate them.
    if (!origin) {
      return callback(null, true);
    }

    if (configuredOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Do not grant browser access to unapproved origins.
    return callback(null, false);
  },

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
  ],

  credentials: false,
  maxAge: 600,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

/*
|--------------------------------------------------------------------------
| REQUEST PARSING
|--------------------------------------------------------------------------
| The payment router must parse PayFast's URL-encoded ITN body before
| its ITN controller runs. Keep its route-specific parser in place.
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "100kb",
    strict: true,
  })
);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
| This confirms that the HTTP process is responding. It does not prove
| Firebase, PayFast, or Telegram is healthy.
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    success: true,
    service: "SA LIVE backend",
    status: "running",
  });
});

app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    success: true,
    status: "ok",
  });
});

/*
|--------------------------------------------------------------------------
| API ROUTES
|--------------------------------------------------------------------------
*/

app.use("/api/hosts", hostRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminManagementRoutes);
app.use("/api/calls", callRoutes);

/*
|--------------------------------------------------------------------------
| NOT FOUND
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found.",
  });
});

/*
|--------------------------------------------------------------------------
| CENTRAL ERROR HANDLER
|--------------------------------------------------------------------------
| Do not return stack traces, database errors, secrets, or provider
| response bodies to API clients.
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : 500;

  if (status >= 500) {
    console.error("Unhandled HTTP request error:", {
      method: req.method,
      path: req.path,
      message: error.message,
      stack: IS_PRODUCTION ? undefined : error.stack,
    });
  }

  res.status(status).json({
    success: false,
    error:
      status === 400
        ? "Invalid request body."
        : status === 413
          ? "Request body is too large."
          : status >= 500
            ? "An internal server error occurred."
            : "Request could not be processed.",
  });
});

/*
|--------------------------------------------------------------------------
| START HTTP SERVER
|--------------------------------------------------------------------------
*/

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`SA LIVE backend listening on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log("Health check available at /health");
  console.log("PayFast ITN route is configured by paymentRoutes.js");
});

server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;

/*
|--------------------------------------------------------------------------
| SERVER ERROR HANDLING
|--------------------------------------------------------------------------
*/

server.on("error", (error) => {
  console.error("HTTP server error:", error.message);

  // A listener failure means this process cannot serve requests reliably.
  process.exitCode = 1;
});

/*
|--------------------------------------------------------------------------
| TELEGRAM BOT STARTUP
|--------------------------------------------------------------------------
| HTTP startup is independent so a Telegram outage does not prevent
| the health endpoint from responding. Monitor bot health separately.
|--------------------------------------------------------------------------
*/

let botStarted = false;
let botStarting = false;

async function startBot() {
  if (botStarted || botStarting) {
    return;
  }

  botStarting = true;

  try {
    console.log("Checking Telegram bot connection...");

    const botInfo = await bot.telegram.getMe();

    console.log(`Telegram connected: @${botInfo.username}`);

    await bot.launch();

    botStarted = true;

    console.log("SA LIVE Telegram bot polling started.");
  } catch (error) {
    console.error(
      "Telegram bot startup failed:",
      error.message
    );
  } finally {
    botStarting = false;
  }
}

void startBot();

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`Received ${signal}; shutting down SA LIVE.`);

  // Stop accepting new HTTP connections and close existing connections.
  const serverClosed = new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        console.error(
          "HTTP server shutdown error:",
          error.message
        );
      }

      resolve();
    });
  });

  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }

  // Stop Telegraf polling if it was started.
  try {
    bot.stop(signal);
  } catch (error) {
    console.error(
      "Telegram shutdown warning:",
      error.message
    );
  }

  await serverClosed;

  console.log("SA LIVE shutdown complete.");
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

export default app;
