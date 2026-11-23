import "express-async-errors";
import http from "http";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { authRouter } from "./auth/auth.router";
import { roomRouter } from "./room/room.router";
import { errorHandler } from "./middleware/errorHandler";
import { attachWebSocket } from "./ws/server";

const app = express();

const allowedOrigins = [
  env.FRONTEND_URL,
  ...(process.env.ADDITIONAL_ORIGINS ? process.env.ADDITIONAL_ORIGINS.split(",").map((s) => s.trim()) : []),
];

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        (env.NODE_ENV !== "production" &&
          (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")))
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

// Health check endpoint for container orchestrators & load balancers
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
  });
});

app.use("/auth", authRouter);
app.use("/rooms", roomRouter);

// Global error handler (must be last)
app.use(errorHandler);

const server = http.createServer(app);

// Attach WebSocket server on /ws path
attachWebSocket(server);

server.listen(env.PORT, () => {
  console.log(`PartyWatch backend & WebSocket server running on port ${env.PORT}`);
});
