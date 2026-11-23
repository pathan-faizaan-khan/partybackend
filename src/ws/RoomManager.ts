import { db } from "../db";
import { rooms, roomPlaybackState } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { Room } from "./Room";

export class RoomManager {
  private static instance: RoomManager;
  private rooms: Map<string, Room> = new Map(); // keyed by uppercase code

  private constructor() {}

  public static getInstance(): RoomManager {
    if (!RoomManager.instance) {
      RoomManager.instance = new RoomManager();
    }
    return RoomManager.instance;
  }

  public async getOrCreateRoom(code: string): Promise<Room | null> {
    const cleanCode = code.trim().toUpperCase();

    // Check memory first
    const existing = this.rooms.get(cleanCode);
    if (existing) {
      return existing;
    }

    // Load from DB
    const roomRecord = await db.query.rooms.findFirst({
      where: and(eq(rooms.code, cleanCode), eq(rooms.status, "active")),
    });

    if (!roomRecord) {
      return null;
    }

    const playback = await db.query.roomPlaybackState.findFirst({
      where: eq(roomPlaybackState.roomId, roomRecord.id),
    });

    const room = new Room({
      id: roomRecord.id,
      code: roomRecord.code,
      name: roomRecord.name,
      videoId: playback?.videoId ?? null,
      playState: (playback?.playState ?? "paused") as "playing" | "paused",
      currentTime: playback?.currentTime ?? 0,
      version: playback?.version ?? 0,
    });

    this.rooms.set(cleanCode, room);
    return room;
  }

  public getRoom(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  public removeRoom(code: string): void {
    this.rooms.delete(code.trim().toUpperCase());
  }
}
