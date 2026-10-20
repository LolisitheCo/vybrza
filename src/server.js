import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { bot } from "./bot/bot.js";

import hostRoutes from "./routes/hostRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

// Configure CORS for your actual frontend domain before production.
// Avoid unrestricted origins if browser clients use authenticated routes.
app.use(cors());

// Parse JSON requests from existing application endpoints.
app.use(express.json({
  limit: "100kb",
}));

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "SA LIVE backend is running.",
  });
});

/*
|--------------------------------------------------------------------------
| HOST ROUTES
|--------------------------------------------------------------------------
*/

app.use(
  "/api/hosts",
  hostRoutes
);

/*
|--------------------------------------------------------------------------
| PAYMENT ROUTES
|--------------------------------------------------------------------------
| The payment router handles its own URL-encoded ITN body parser.
|--------------------------------------------------------------------------
*/

app.use(
  "/api/payments",
  paymentRoutes
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const server = app.listen(PORT, () => {
  console.log(
    `SA LIVE backend running on port ${PORT}`
  );

  console.log(
    `PayFast ITN endpoint: POST /api/payments/payfast/itn`
  );
});

/*
|--------------------------------------------------------------------------
| START TELEGRAM BOT
|--------------------------------------------------------------------------
*/

async function startBot() {
  try {
    console.log(
      "Testing Telegram bot connection..."
    );

    const botInfo = await bot.telegram.getMe();

    console.log(
      `Telegram connected: @${botInfo.username}`
    );

    console.log(
      "Starting Telegram polling..."
    );

    await bot.launch();

    console.log(
      "SA LIVE Telegram bot polling started."
    );
  } catch (error) {
    console.error(
      "Telegram bot startup failed:",
      error.message
    );
  }
}

startBot();

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

  console.log(
    `Received ${signal}. Shutting down SA LIVE...`
  );

  try {
    bot.stop(signal);
  } catch (error) {
    console.error(
      "Telegram shutdown warning:",
      error.message
    );
  }

  server.close((error) => {
    if (error) {
      console.error(
        "HTTP server shutdown failed:",
        error.message
      );

      process.exitCode = 1;
    }

    console.log(
      "SA LIVE HTTP server stopped."
    );
  });
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

export default app;