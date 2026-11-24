import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";
import { verifyAccessToken } from "../utils/jwt";
import { getOrCreateParticipant } from "../room/room.service";
import { RoomManager } from "./RoomManager";
import { Participant } from "./Participant";
import type { ClientMessage } from "./types";
import { db } from "../db";
import { users, roomParticipants, roomConnections } from "../../db/schema";
import { eq, and } from "drizzle-orm";

export function attachWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024, // 64KB max payload prevents DoS attacks
  });
  const roomManager = RoomManager.getInstance();

  wss.on("connection", async (ws: WebSocket, req) => {
    let participant: Participant | null = null;
    let currentRoomCode: string | null = null;
    let hasJoined = false;

    // Heartbeat setup
    let isAlive = true;
    ws.on("pong", () => {
      isAlive = true;
    });

    const parsed = parseUrl(req.url || "", true);
    const tokenQuery = parsed.query.token as string | undefined;
    const codeQuery = parsed.query.code as string | undefined;
    const userIdQuery = parsed.query.userId as string | undefined;
    const usernameQuery = parsed.query.username as string | undefined;

    /**
     * Resolves user identity from token, user ID, or cookie.
     * Guarantees that valid connections can always join the room.
     */
    const resolveIdentity = async (
      token?: string,
      providedUserId?: string,
      providedUsername?: string,
    ): Promise<{ userId: string; username: string }> => {
      // 1. Try JWT access token
      if (token) {
        try {
          const payload = verifyAccessToken(token);
          if (payload?.sub && payload?.username) {
            return { userId: payload.sub, username: payload.username };
          }
        } catch {
          // Token expired or invalid, fall through to user lookup
        }
      }

      // 2. Try provided user ID (Only allowed for verified guest accounts; registered users MUST present valid JWT)
      if (providedUserId) {
        const userRecord = await db.query.users.findFirst({
          where: eq(users.id, providedUserId),
        });
        if (userRecord && userRecord.isGuest) {
          return { userId: userRecord.id, username: providedUsername || userRecord.username };
        }
      }

      // 3. Fallback: create or use guest identity
      const name = providedUsername?.trim() || "Guest";
      const [guest] = await db
        .insert(users)
        .values({
          username: name,
          isGuest: true,
        })
        .returning();

      if (!guest) {
        throw new Error("Failed to create guest user");
      }

      return { userId: guest.id, username: guest.username };
    };

    /**
     * Joins user to room and broadcasts update to all room members
     */
    const joinRoom = async (opts: {
      code: string;
      token?: string;
      userId?: string;
      username?: string;
    }) => {
      const { code, token, userId: inputUserId, username: inputUsername } = opts;
      if (!code || hasJoined) return;

      try {
        const room = await roomManager.getOrCreateRoom(code);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Room not found" } }));
          ws.close(4004, "Room not found");
          return;
        }

        const identity = await resolveIdentity(token, inputUserId, inputUsername);
        const member = await getOrCreateParticipant(room.id, identity.userId, identity.username);

        const wasAlreadyInRoom = room.participants.has(member.userId);

        room.clearEmptyRoomTimer();

        if (member.role == "host") {
          room.clearEmptyRoomTimer();
        }

        participant = new Participant({
          userId: member.userId,
          username: member.username,
          role: member.role,
          avatarUrl: member.avatarUrl,
          roomId: room.id,
          roomCode: room.code,
          ws,
        });

        currentRoomCode = room.code;
        room.addParticipant(participant);
        hasJoined = true;

        room.clearEmptyRoomTimer();
        if (participant.role === "host") {
          room.clearHostDisconnectTimer();
        }

        // Update DB presence
        await db
          .update(roomParticipants)
          .set({ isOnline: true, lastSeenAt: new Date() })
          .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, participant.userId)))
          .catch(() => { });

        // Log connection in DB
        const socketId = Math.random().toString(36).slice(2, 12);
        await db
          .insert(roomConnections)
          .values({
            roomId: room.id,
            participantId: participant.userId,
            socketId,
            connectedAt: new Date(),
          })
          .catch(() => { });

        // 1. Send full room state snapshot to the connecting user
        participant.send("room_state", {
          playback: room.getSyncState(),
          members: room.getParticipantsList(),
          messages: [],
          requests: Array.from(room.requests.values()),
        });

        // 2. Only broadcast user_joined if the user wasn't already connected
        if (!wasAlreadyInRoom) {
          room.broadcast("user_joined", {
            userId: participant.userId,
            username: participant.username,
            role: participant.role,
            avatarUrl: participant.avatarUrl,
            participants: room.getParticipantsList(),
          });
        }

        // 3. Immediately send current sync state to new joiner
        participant.send("sync_state", room.getSyncState());

        await room.logEvent(participant.userId, "join_room", "accepted").catch(() => { });
        console.log(`[WS] ${participant.username} (${participant.role}) joined room ${room.code}. Total: ${room.participants.size}`);
      } catch (err: any) {
        console.error("WebSocket join room error:", err);
        ws.send(JSON.stringify({ type: "error", payload: { message: err?.message || "Failed to join room" } }));
      }
    };

    // Auto-join on connect if room code is available in query
    if (codeQuery) {
      await joinRoom({
        code: codeQuery,
        token: tokenQuery,
        userId: userIdQuery,
        username: usernameQuery,
      });
    }

    // Handle incoming client messages
    ws.on("message", async (data: Buffer | string) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());

        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (msg.type === "join_room") {
          if (!hasJoined) {
            const { code, token, userId, username } = msg.payload || {};
            await joinRoom({
              code: code || currentRoomCode || codeQuery,
              token: token || tokenQuery,
              userId: userId || userIdQuery,
              username: username || usernameQuery,
            });
          }
          return;
        }

        // If not joined yet, attempt joining with query context
        if (!participant || !currentRoomCode) {
          if (codeQuery) {
            await joinRoom({
              code: codeQuery,
              token: tokenQuery || msg.payload?.token,
              userId: userIdQuery || msg.payload?.userId,
              username: usernameQuery || msg.payload?.username,
            });
          }
          if (!participant || !currentRoomCode) {
            ws.send(JSON.stringify({ type: "error", payload: { message: "Not authenticated in room" } }));
            return;
          }
        }

        const room = roomManager.getRoom(currentRoomCode);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Room not found" } }));
          return;
        }

        switch (msg.type) {
          case "play": {
            if (!participant.canControl) {
              await room.logEvent(participant.userId, "play", "rejected", "Requires host or moderator role");
              participant.send("error", { message: "You don't have permission to play video" });
              return;
            }
            const time = typeof msg.payload?.time === "number" ? msg.payload.time : room.calculateCurrentTime();
            await room.applyPlayback({ playState: "playing", currentTime: time }, participant.userId);
            await room.logEvent(participant.userId, "play", "accepted", undefined, msg.payload);
            break;
          }

          case "pause": {
            if (!participant.canControl) {
              await room.logEvent(participant.userId, "pause", "rejected", "Requires host or moderator role");
              participant.send("error", { message: "You don't have permission to pause video" });
              return;
            }
            const time = typeof msg.payload?.time === "number" ? msg.payload.time : room.calculateCurrentTime();
            await room.applyPlayback({ playState: "paused", currentTime: time }, participant.userId);
            await room.logEvent(participant.userId, "pause", "accepted", undefined, msg.payload);
            break;
          }

          case "seek": {
            if (!participant.canControl) {
              await room.logEvent(participant.userId, "seek", "rejected", "Requires host or moderator role");
              participant.send("error", { message: "You don't have permission to seek video" });
              return;
            }
            if (typeof msg.payload?.time === "number") {
              await room.applyPlayback({ currentTime: msg.payload.time }, participant.userId);
              await room.logEvent(participant.userId, "seek", "accepted", undefined, msg.payload);
            }
            break;
          }

          case "change_video": {
            if (!participant.canControl) {
              await room.logEvent(participant.userId, "change_video", "rejected", "Requires host or moderator role");
              participant.send("error", { message: "You don't have permission to change video" });
              return;
            }
            if (msg.payload?.videoId) {
              await room.applyPlayback(
                { videoId: msg.payload.videoId, currentTime: 0, playState: "playing" },
                participant.userId,
              );
              await room.logEvent(participant.userId, "change_video", "accepted", undefined, msg.payload);
            }
            break;
          }

          case "assign_role": {
            if (!participant.canManage) {
              await room.logEvent(participant.userId, "assign_role", "rejected", "Requires host role");
              participant.send("error", { message: "Only the host can assign roles" });
              return;
            }
            const { userId, role } = msg.payload || {};
            if (userId && role) {
              await room.assignRole(userId, role, participant.userId);
              await room.logEvent(participant.userId, "assign_role", "accepted", undefined, msg.payload, userId);
            }
            break;
          }

          case "remove_participant": {
            if (!participant.canManage) {
              await room.logEvent(participant.userId, "remove_participant", "rejected", "Requires host role");
              participant.send("error", { message: "Only the host can remove participants" });
              return;
            }
            const { userId } = msg.payload || {};
            if (userId) {
              await room.removeUser(userId, participant.userId);
              await room.logEvent(participant.userId, "remove_participant", "accepted", undefined, msg.payload, userId);
            }
            break;
          }

          case "chat_message": {
            const body = msg.payload?.body;
            if (body && typeof body === "string") {
              const trimmed = body.trim().slice(0, 500);
              if (trimmed.length > 0) {
                room.addChatMessage(participant.userId, participant.username, trimmed);
              }
            }
            break;
          }

          case "reaction": {
            const emoji = msg.payload?.emoji;
            if (emoji && typeof emoji === "string" && emoji.length <= 16) {
              room.sendReaction(participant.userId, emoji);
            }
            break;
          }

          case "change_request": {
            const { kind, time, videoId } = msg.payload || {};
            if (kind) {
              await room.createChangeRequest(participant.userId, participant.username, kind, { time, videoId });
              await room.logEvent(participant.userId, "change_request_created", "accepted", undefined, msg.payload);
            }
            break;
          }

          case "resolve_request": {
            if (!participant.canControl) {
              participant.send("error", { message: "Only hosts and moderators can approve requests" });
              return;
            }
            const { id, approve } = msg.payload || {};
            if (id) {
              await room.resolveChangeRequest(id, Boolean(approve), participant.userId);
              await room.logEvent(participant.userId, "change_request_resolved", "accepted", undefined, msg.payload);
            }
            break;
          }

          case "close_room": {
            if (!participant.canManage) {
              await room.logEvent(participant.userId, "room_closed", "rejected", "Requires host role");
              participant.send("error", { message: "Only the host can close the watch party" });
              return;
            }
            await room.closeRoom(participant.userId);
            roomManager.removeRoom(room.code);
            console.log(`[WS] Host closed room ${room.code}`);
            break;
          }

          case "leave_room": {
            const transferHost = Boolean(msg.payload?.transferHost);
            if (participant.role === "host" && transferHost) {
              await room.handleHostLeave(participant.userId).catch(() => { });
            }
            ws.close(1000, "Left room");
            break;
          }
        }
      } catch (err) {
        console.error("Error processing WebSocket message:", err);
      }
    });

    // Handle connection close / cleanup
    ws.on("close", async () => {
      if (participant && currentRoomCode) {
        const room = roomManager.getRoom(currentRoomCode);
        if (room) {
          const leavingUserId = participant.userId;
          const leavingUsername = participant.username;
          const leavingRole = participant.role;

          room.removeParticipant(leavingUserId);

          if (leavingRole == "host") {
            room.startHostDisconnectTimer(async () => {
              await room.closeRoom("system", "Room closed: Host disconnected");
              roomManager.removeRoom(room.code);
            });
          }

          if (room.participants.size === 0) {
            room.startEmptyRoomTimer(async () => {
              await room.closeRoom("system", "Room closed: No participants left");
              roomManager.removeRoom(room.code);
            })
          }
          // Update DB presence
          await db
            .update(roomParticipants)
            .set({ isOnline: false, lastSeenAt: new Date() })
            .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.userId, leavingUserId)))
            .catch(() => { });

          // Debounce user_left broadcast by 3.5 seconds:
          // If the user simply refreshed the page or had a transient socket reconnect,
          // do NOT spam "left" and "joined" toasts!
          setTimeout(() => {
            const reconnected = room.participants.get(leavingUserId);
            if (!reconnected) {
              room.broadcast("user_left", {
                userId: leavingUserId,
                username: leavingUsername,
                role: leavingRole,
                participants: room.getParticipantsList(),
              });
            }
          }, 3500);
        }
      }
    });
  });

  // Heartbeat interval (every 30 seconds)
  const interval = setInterval(() => {
    wss.clients.forEach((ws: any) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  return wss;
}
