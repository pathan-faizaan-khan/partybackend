import { Router } from "express";
import type { Request, Response } from "express";
import { registerSchema, loginSchema } from "./auth.schema";
import * as authService from "./auth.service";
import { authenticate } from "../middleware/authenticate";
import { loginLimiter, registerLimiter } from "../middleware/rateLimiter";
import { db } from "../db";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";

export const authRouter = Router();

// POST /auth/register
authRouter.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);
  const ip = req.ip;
  const ua = req.headers["user-agent"];
  const result = await authService.register(body, res, ip, ua);
  res.status(201).json({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
  });
});

// POST /auth/login
authRouter.post("/login", loginLimiter, async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);
  const ip = req.ip;
  const ua = req.headers["user-agent"];
  const result = await authService.login(body, res, ip, ua);
  res.json({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
  });
});

// POST /auth/refresh
authRouter.post("/refresh", async (req: Request, res: Response) => {
  const rawToken: string | undefined = req.cookies["refresh_token"] || req.body?.refreshToken;
  if (!rawToken) {
    res.status(401).json({ error: "Missing refresh token" });
    return;
  }
  const result = await authService.refreshToken(rawToken, res);
  res.json({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

// POST /auth/logout
authRouter.post("/logout", async (req: Request, res: Response) => {
  const rawToken: string | undefined = req.cookies["refresh_token"] || req.body?.refreshToken;
  if (rawToken) {
    await authService.logout(rawToken, res);
  }
  res.status(204).send();
});

// GET /auth/me
authRouter.get("/me", authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).user.sub as string;
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      username: true,
      email: true,
      avatarUrl: true,
      isGuest: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user });
});
