import crypto from "crypto";
import { db } from "../db";
import { users, userSessions } from "../../db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../utils/hash";
import { generateRefreshToken, hashToken } from "../utils/crypto";
import { signAccessToken } from "../utils/jwt";
import { env } from "../config/env";
import type { RegisterInput, LoginInput } from "./auth.schema";

function makeRefreshExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.JWT_REFRESH_EXPIRES_DAYS);
  return d;
}

function setCookieToken(res: import("express").Response, rawToken: string): void {
  res.cookie("refresh_token", rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: env.JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

/**
 * In-memory grace period cache for rotated refresh tokens (60-second window).
 * Prevents race conditions from concurrent frontend fetches (e.g., Promise.all or duplicate retries)
 * from invalidating active user sessions.
 */
interface RotatedTokenGrace {
  userId: string;
  accessToken: string;
  refreshToken: string;
  rotatedAt: number;
}
const rotatedGraceMap = new Map<string, RotatedTokenGrace>();

// Clean up stale grace entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [hash, item] of rotatedGraceMap.entries()) {
    if (now - item.rotatedAt > 120_000) {
      rotatedGraceMap.delete(hash);
    }
  }
}, 60_000).unref();

export async function register(
  data: RegisterInput,
  res: import("express").Response,
  ip?: string,
  userAgent?: string,
) {
  // Check email uniqueness
  const existing = await db.query.users.findFirst({
    where: eq(users.email, data.email),
    columns: { id: true },
  });
  if (existing) {
    const err = Object.assign(new Error("Email already in use"), { status: 409 });
    throw err;
  }

  const passwordHash = await hashPassword(data.password);
  const userId = crypto.randomUUID();

  // Insert user with primary id and authUserId populated
  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      authUserId: userId,
      username: data.username,
      email: data.email,
      passwordHash,
      isGuest: false,
    })
    .returning({
      id: users.id,
      username: users.username,
      email: users.email,
      isGuest: users.isGuest,
      createdAt: users.createdAt,
    });

  if (!user) throw new Error("Failed to create user");

  // Generate tokens
  const accessToken = signAccessToken({ sub: user.id, email: user.email!, username: user.username });
  const rawRefresh = generateRefreshToken();
  const tokenHash = hashToken(rawRefresh);

  await db.insert(userSessions).values({
    userId: user.id,
    tokenHash,
    userAgent: userAgent ?? null,
    ipAddress: ip ?? null,
    expiresAt: makeRefreshExpiry(),
  });

  setCookieToken(res, rawRefresh);

  return { accessToken, refreshToken: rawRefresh, user };
}

export async function login(
  data: LoginInput,
  res: import("express").Response,
  ip?: string,
  userAgent?: string,
) {
  const user = await db.query.users.findFirst({
    where: eq(users.email, data.email),
  });

  // Generic error — don't leak whether user exists
  const invalidCreds = Object.assign(new Error("Invalid credentials"), { status: 401 });

  if (!user || !user.passwordHash) throw invalidCreds;

  const valid = await verifyPassword(data.password, user.passwordHash);
  if (!valid) throw invalidCreds;

  // Create a new session
  const rawRefresh = generateRefreshToken();
  const tokenHash = hashToken(rawRefresh);

  await db.insert(userSessions).values({
    userId: user.id,
    tokenHash,
    userAgent: userAgent ?? null,
    ipAddress: ip ?? null,
    expiresAt: makeRefreshExpiry(),
  });

  const accessToken = signAccessToken({ sub: user.id, email: user.email || "", username: user.username });

  setCookieToken(res, rawRefresh);

  return {
    accessToken,
    refreshToken: rawRefresh,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isGuest: user.isGuest,
      createdAt: user.createdAt,
    },
  };
}

export async function refreshToken(rawToken: string, res: import("express").Response) {
  const tokenHash = hashToken(rawToken);

  // 1. Check grace period cache: if this token was rotated within the last 60 seconds,
  // return the already-issued new tokens instead of failing with 401.
  const grace = rotatedGraceMap.get(tokenHash);
  if (grace && Date.now() - grace.rotatedAt < 60_000) {
    setCookieToken(res, grace.refreshToken);
    return {
      accessToken: grace.accessToken,
      refreshToken: grace.refreshToken,
    };
  }

  // 2. Query session in database
  const session = await db.query.userSessions.findFirst({
    where: and(
      eq(userSessions.tokenHash, tokenHash),
      gt(userSessions.expiresAt, new Date()),
      isNull(userSessions.revokedAt),
    ),
  });

  if (!session) {
    const err = Object.assign(new Error("Invalid or expired refresh token"), { status: 401 });
    throw err;
  }

  // Load user separately
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  if (!user) {
    const err = Object.assign(new Error("User not found"), { status: 401 });
    throw err;
  }

  // 3. Rotate refresh token
  const newRaw = generateRefreshToken();
  const newHash = hashToken(newRaw);

  await db
    .update(userSessions)
    .set({ tokenHash: newHash, lastUsedAt: new Date() })
    .where(eq(userSessions.id, session.id));

  const accessToken = signAccessToken({ sub: user.id, email: user.email || "", username: user.username });

  setCookieToken(res, newRaw);

  // Store old token hash in grace cache for 60 seconds
  rotatedGraceMap.set(tokenHash, {
    userId: user.id,
    accessToken,
    refreshToken: newRaw,
    rotatedAt: Date.now(),
  });

  return { accessToken, refreshToken: newRaw };
}

export async function logout(rawToken: string, res: import("express").Response) {
  const tokenHash = hashToken(rawToken);

  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(eq(userSessions.tokenHash, tokenHash));

  rotatedGraceMap.delete(tokenHash);
  res.clearCookie("refresh_token", { path: "/" });
}
