import { db } from "../db";
import { rooms, roomParticipants, roomPlaybackState, users } from "../../db/schema";
import { eq, and } from "drizzle-orm";

export function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export async function createRoom(userId: string, username: string, codeInput?: string, nameInput?: string) {
  let code = codeInput ? codeInput.trim().toUpperCase() : generateRoomCode();
  const name = nameInput?.trim() || `Room ${code}`;

  // Ensure unique code
  let attempts = 0;
  while (attempts < 5) {
    const existing = await db.query.rooms.findFirst({
      where: eq(rooms.code, code),
      columns: { id: true },
    });
    if (!existing) break;
    code = generateRoomCode();
    attempts++;
  }

  // Create room
  const [room] = await db
    .insert(rooms)
    .values({
      code,
      name,
      createdBy: userId,
      status: "active",
      isPersistent: true,
    })
    .returning();

  if (!room) {
    throw new Error("Failed to create room in database");
  }

  // Add creator as host
  await db.insert(roomParticipants).values({
    roomId: room.id,
    userId,
    username,
    role: "host",
    status: "active",
    isOnline: false,
  });

  // Initialize playback state
  await db.insert(roomPlaybackState).values({
    roomId: room.id,
    videoId: null,
    playState: "paused",
    currentTime: 0,
    version: 0,
    updatedBy: userId,
  });

  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    videoId: null,
    playState: "paused" as const,
    currentTime: 0,
  };
}

export async function getRoomByCode(code: string) {
  const cleanCode = code.trim().toUpperCase();

  const room = await db.query.rooms.findFirst({
    where: and(eq(rooms.code, cleanCode), eq(rooms.status, "active")),
  });

  if (!room) return null;

  const playback = await db.query.roomPlaybackState.findFirst({
    where: eq(roomPlaybackState.roomId, room.id),
  });

  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    videoId: playback?.videoId ?? null,
    playState: (playback?.playState ?? "paused") as "playing" | "paused",
    currentTime: playback?.currentTime ?? 0,
  };
}

export async function getOrCreateParticipant(roomId: string, userId: string, defaultUsername: string) {
  const existing = await db.query.roomParticipants.findFirst({
    where: and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId)),
  });

  if (existing) {
    // If removed/banned, handle accordingly
    if (existing.isBanned || existing.status === "removed") {
      const err = Object.assign(new Error("You have been removed from this room"), { status: 403 });
      throw err;
    }

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { avatarUrl: true },
    });

    return {
      userId: existing.userId,
      username: existing.username,
      role: existing.role,
      isOnline: existing.isOnline,
      avatarUrl: userRecord?.avatarUrl ?? null,
    };
  }

  // Verify room creator
  const roomRecord = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    columns: { createdBy: true },
  });

  // Check if room has an active host
  const activeHost = await db.query.roomParticipants.findFirst({
    where: and(
      eq(roomParticipants.roomId, roomId),
      eq(roomParticipants.role, "host"),
      eq(roomParticipants.status, "active"),
    ),
  });

  // Every new joiner MUST join strictly as "participant".
  // Only the room creator can be assigned "host" if no active host exists.
  let role: "host" | "moderator" | "participant" | "viewer" = "participant";
  if (roomRecord?.createdBy === userId && !activeHost) {
    role = "host";
  }

  const [created] = await db
    .insert(roomParticipants)
    .values({
      roomId,
      userId,
      username: defaultUsername,
      role,
      status: "active",
      isOnline: false,
    })
    .returning();

  if (!created) {
    throw new Error("Failed to create room participant");
  }

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { avatarUrl: true },
  });

  return {
    userId: created.userId,
    username: created.username,
    role: created.role,
    isOnline: created.isOnline,
    avatarUrl: userRecord?.avatarUrl ?? null,
  };
}

export async function getParticipants(roomId: string) {
  const participants = await db
    .select({
      userId: roomParticipants.userId,
      username: roomParticipants.username,
      role: roomParticipants.role,
      isOnline: roomParticipants.isOnline,
      avatarUrl: users.avatarUrl,
    })
    .from(roomParticipants)
    .leftJoin(users, eq(roomParticipants.userId, users.id))
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.status, "active")));

  return participants;
}
