import { db } from "../db";
import {
  rooms,
  roomPlaybackState,
  roomVideoHistory,
  roomEvents,
  changeRequests,
  roomParticipants,
  roleChanges,
} from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Participant } from "./Participant";
import type {
  ChatMessageData,
  ParticipantInfo,
  PendingRequest,
  PlaybackState,
  PlayState,
  RequestKind,
  RoomRole,
} from "./types";

export class Room {
  public id: string;
  public code: string;
  public name: string;
  public participants: Map<string, Participant> = new Map();
  public requests: Map<string, PendingRequest> = new Map();

  // Playback state
  public videoId: string | null = null;
  public playState: PlayState = "paused";
  public currentTime: number = 0;
  public stateUpdatedAt: number = Date.now();
  public version: number = 0;
  private hostDisconnectTimeout: NodeJS.Timeout | null = null;
  private emptyRoomTimeout: NodeJS.Timeout | null = null;

  constructor(opts: {
    id: string;
    code: string;
    name: string;
    videoId?: string | null;
    playState?: PlayState;
    currentTime?: number;
    version?: number;
  }) {
    this.id = opts.id;
    this.code = opts.code;
    this.name = opts.name;
    this.videoId = opts.videoId ?? null;
    this.playState = opts.playState ?? "paused";
    this.currentTime = opts.currentTime ?? 0;
    this.version = opts.version ?? 0;
    this.stateUpdatedAt = Date.now();
  }

  /** Calculate current elapsed time if video is playing */
  public calculateCurrentTime(): number {
    if (this.playState === "playing") {
      const elapsed = (Date.now() - this.stateUpdatedAt) / 1000;
      return Math.max(0, this.currentTime + elapsed);
    }
    return this.currentTime;
  }

  public startHostDisconnectTimer(onTimeout: () => void): void {
    if (this.hostDisconnectTimeout) {
      return;
    }

    this.broadcast("host_offline_warning", {
      message: "The host has disconnected. The party will close in 5 minutes if the host does not return.",
      timeoutSeconds: 300,
    });

    this.hostDisconnectTimeout = setTimeout(() => {
      console.log(`[Room ${this.code}] Host failed to return within 5 minutes. Closing room.`);
      onTimeout();
    }, 5 * 60 * 1000);
  }

  public clearHostDisconnectTimer(): void {
    if (this.hostDisconnectTimeout) {
      clearTimeout(this.hostDisconnectTimeout);
      this.hostDisconnectTimeout = null;
      this.broadcast("host_reconnected", {
        message: "The host has reconnected."
      });
    }
  }

  public startEmptyRoomTimer(onTimeout: () => void): void {
    if (this.emptyRoomTimeout) {
      return;
    }

    this.emptyRoomTimeout = setTimeout(() => {
      if (this.participants.size == 0) {
        console.log(`[Room ${this.code}] Room is empty. Closing room.`);
        onTimeout();
      }
    }, 60 * 1000);
  }

  public clearEmptyRoomTimer(): void {
    if (this.emptyRoomTimeout) {
      clearTimeout(this.emptyRoomTimeout);
      this.emptyRoomTimeout = null;
    }
  }

  public getSyncState(): PlaybackState {
    return {
      videoId: this.videoId,
      playState: this.playState,
      currentTime: this.calculateCurrentTime(),
      updatedAt: this.stateUpdatedAt,
      version: this.version,
    };
  }

  public getParticipantsList(): ParticipantInfo[] {
    return Array.from(this.participants.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      role: p.role,
      isOnline: true,
      avatarUrl: p.avatarUrl,
    }));
  }

  public addParticipant(participant: Participant): void {
    this.participants.set(participant.userId, participant);
  }

  public removeParticipant(userId: string): Participant | undefined {
    const p = this.participants.get(userId);
    if (p) {
      this.participants.delete(userId);
    }
    return p;
  }

  public getParticipant(userId: string): Participant | undefined {
    return this.participants.get(userId);
  }

  public broadcast(type: string, payload: unknown, excludeUserId?: string): void {
    for (const [id, participant] of this.participants.entries()) {
      if (excludeUserId && id === excludeUserId) continue;
      participant.send(type, payload);
    }
  }

  public broadcastSyncState(): void {
    this.broadcast("sync_state", this.getSyncState());
  }

  public async applyPlayback(
    patch: { videoId?: string | null; playState?: PlayState; currentTime?: number },
    actorId?: string,
  ): Promise<void> {
    const isChangingVideo = patch.videoId !== undefined && patch.videoId !== this.videoId;

    if (patch.videoId !== undefined) this.videoId = patch.videoId;
    if (patch.playState !== undefined) this.playState = patch.playState;
    if (patch.currentTime !== undefined) this.currentTime = Math.max(0, patch.currentTime);

    this.stateUpdatedAt = Date.now();
    this.version += 1;

    // Broadcast immediate sync state to all clients
    this.broadcastSyncState();

    // Persist playback state to database asynchronously
    try {
      await db
        .update(roomPlaybackState)
        .set({
          videoId: this.videoId,
          playState: this.playState,
          currentTime: this.currentTime,
          stateUpdatedAt: new Date(this.stateUpdatedAt),
          version: this.version,
          updatedBy: actorId,
        })
        .where(eq(roomPlaybackState.roomId, this.id));

      if (isChangingVideo && this.videoId) {
        await db.insert(roomVideoHistory).values({
          roomId: this.id,
          videoId: this.videoId,
          changedBy: actorId,
          startedAt: new Date(),
        });
      }
    } catch (err) {
      console.error(`Failed to update playback state in DB for room ${this.code}:`, err);
    }
  }



  public sendReaction(userId: string, emoji: string): void {
    const id = Math.random().toString(36).slice(2, 10);
    const x = 12 + Math.random() * 76;
    const data = { id, emoji, x, userId };

    this.broadcast("reaction", data);
  }

  public async assignRole(targetUserId: string, newRole: RoomRole, actorId: string): Promise<void> {
    const target = this.participants.get(targetUserId);

    // 1. If transferring host, FIRST demote current host to moderator in DB and memory
    if (newRole === "host") {
      const actorParticipant = this.participants.get(actorId);
      if (actorParticipant) {
        actorParticipant.role = "moderator";
      }
      await db
        .update(roomParticipants)
        .set({ role: "moderator", updatedAt: new Date() })
        .where(and(eq(roomParticipants.roomId, this.id), eq(roomParticipants.userId, actorId)));
    }

    // 2. Update target in database
    await db
      .update(roomParticipants)
      .set({ role: newRole, updatedAt: new Date() })
      .where(and(eq(roomParticipants.roomId, this.id), eq(roomParticipants.userId, targetUserId)));

    if (target) {
      target.role = newRole;
    }

    // Record audit log
    await db.insert(roleChanges).values({
      roomId: this.id,
      targetUserId,
      changedBy: actorId,
      toRole: newRole,
      reason: newRole === "host" ? "host_transferred" : "assigned",
    }).catch(() => { });

    this.broadcast("role_assigned", {
      userId: targetUserId,
      username: target?.username ?? "User",
      role: newRole,
      participants: this.getParticipantsList(),
    });
  }

  public async closeRoom(actorId: string, customMessage?: string): Promise<void> {
    await db
      .update(rooms)
      .set({
        status: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rooms.id, this.id));

    await db
      .update(roomPlaybackState)
      .set({
        playState: "paused",
        stateUpdatedAt: new Date(),
      })
      .where(eq(roomPlaybackState.roomId, this.id));

    this.clearHostDisconnectTimer();
    this.clearEmptyRoomTimer();

    const message = customMessage || "The party has ended.";
    this.broadcast("room_closed", { message });

    await this.logEvent(actorId, "room_closed", "accepted").catch(() => { });

    for (const p of this.participants.values()) {
      p.close(4000, "Room ended by host");
    }
    this.participants.clear();
  }

  public async handleHostLeave(leavingUserId: string): Promise<void> {
  }

  public async removeUser(targetUserId: string, actorId: string): Promise<void> {
    const target = this.participants.get(targetUserId);

    await db
      .update(roomParticipants)
      .set({
        status: "removed",
        isOnline: false,
        removedAt: new Date(),
        removedBy: actorId,
      })
      .where(and(eq(roomParticipants.roomId, this.id), eq(roomParticipants.userId, targetUserId)));

    if (target) {
      target.send("participant_removed", { userId: targetUserId });
      target.close(4001, "Removed by host");
      this.participants.delete(targetUserId);
    }

    this.broadcast("participant_removed", {
      userId: targetUserId,
      participants: this.getParticipantsList(),
    });
  }

  public async createChangeRequest(
    userId: string,
    username: string,
    kind: RequestKind,
    extra: { time?: number; videoId?: string } = {},
  ): Promise<PendingRequest> {
    const id = Math.random().toString(36).slice(2, 10);
    const req: PendingRequest = {
      id,
      userId,
      username,
      kind,
      time: extra.time,
      videoId: extra.videoId,
      createdAt: Date.now(),
    };

    this.requests.set(id, req);

    // Save to DB asynchronously
    db.insert(changeRequests)
      .values({
        roomId: this.id,
        requesterId: userId,
        type: kind,
        requestedTime: extra.time,
        requestedVideoId: extra.videoId,
        status: "pending",
      })
      .catch((err) => console.error("Failed to insert change request:", err));

    this.broadcast("change_request_created", req);
    return req;
  }

  public async resolveChangeRequest(id: string, approve: boolean, actorId: string): Promise<void> {
    const req = this.requests.get(id);
    if (!req) return;

    this.requests.delete(id);

    this.broadcast("change_request_resolved", { id, approve });

    if (approve) {
      if (req.kind === "play") {
        await this.applyPlayback({ playState: "playing" }, actorId);
      } else if (req.kind === "pause") {
        await this.applyPlayback({ playState: "paused" }, actorId);
      } else if (req.kind === "seek" && req.time !== undefined) {
        await this.applyPlayback({ currentTime: req.time }, actorId);
      } else if (req.kind === "change_video" && req.videoId) {
        await this.applyPlayback({ videoId: req.videoId, currentTime: 0, playState: "playing" }, actorId);
      }
    }

    // Update DB
    db.update(changeRequests)
      .set({
        status: approve ? "approved" : "rejected",
        resolvedBy: actorId,
        resolvedAt: new Date(),
      })
      .where(and(eq(changeRequests.roomId, this.id), eq(changeRequests.requesterId, req.userId)))
      .catch((err) => console.error("Failed to update change request in DB:", err));
  }

  public async logEvent(
    actorId: string | null,
    type: any,
    outcome: "accepted" | "rejected",
    reason?: string,
    payload: Record<string, unknown> = {},
    targetUserId?: string,
  ): Promise<void> {
    try {
      await db.insert(roomEvents).values({
        roomId: this.id,
        actorId,
        targetUserId,
        type,
        outcome,
        rejectionReason: reason,
        payload,
      });
    } catch (err) {
      console.error("Failed to log room event:", err);
    }
  }

  public async addChatMessage(userId: string, username: string, body: string): Promise<ChatMessageData> {
    const cleanBody = body.trim().slice(0, 500);
    const data: ChatMessageData = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      userId,
      username,
      body: cleanBody,
      createdAt: Date.now(),
    };

    this.broadcast("chat_message", data);
    return data;
  }

  public async getRecentMessages(): Promise<ChatMessageData[]> {
    return [];
  }
}
