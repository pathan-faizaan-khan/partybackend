import type { WebSocket } from "ws";
import type { RoomRole } from "./types";

export class Participant {
  public userId: string;
  public username: string;
  public role: RoomRole;
  public avatarUrl?: string | null;
  public roomId: string;
  public roomCode: string;
  public ws: WebSocket;
  public isAlive: boolean = true;

  constructor(opts: {
    userId: string;
    username: string;
    role: RoomRole;
    avatarUrl?: string | null;
    roomId: string;
    roomCode: string;
    ws: WebSocket;
  }) {
    this.userId = opts.userId;
    this.username = opts.username;
    this.role = opts.role;
    this.avatarUrl = opts.avatarUrl;
    this.roomId = opts.roomId;
    this.roomCode = opts.roomCode;
    this.ws = opts.ws;
  }

  public get canControl(): boolean {
    return this.role === "host" || this.role === "moderator";
  }

  public get canManage(): boolean {
    return this.role === "host";
  }

  public send(type: string, payload: unknown): void {
    if (this.ws.readyState === 1 /* WebSocket.OPEN */) {
      try {
        this.ws.send(JSON.stringify({ type, payload }));
      } catch (err) {
        console.error(`Failed to send message to ${this.username} (${this.userId}):`, err);
      }
    }
  }

  public close(code?: number, reason?: string): void {
    if (this.ws.readyState === 1 || this.ws.readyState === 0) {
      try {
        this.ws.close(code, reason);
      } catch {
        // Ignore
      }
    }
  }
}
