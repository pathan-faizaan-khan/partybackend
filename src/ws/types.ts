export type RoomRole = "host" | "moderator" | "participant" | "viewer";
export type PlayState = "playing" | "paused";
export type RequestKind = "play" | "pause" | "seek" | "change_video";

export interface ParticipantInfo {
  userId: string;
  username: string;
  role: RoomRole;
  isOnline: boolean;
  avatarUrl?: string | null;
}

export interface PlaybackState {
  videoId: string | null;
  playState: PlayState;
  currentTime: number;
  updatedAt: number;
  version: number;
}

export interface PendingRequest {
  id: string;
  userId: string;
  username: string;
  kind: RequestKind;
  time?: number;
  videoId?: string;
  createdAt: number;
}

export interface ChatMessageData {
  id: string;
  userId: string;
  username: string;
  body: string;
  createdAt: number;
}

export interface ReactionData {
  id: string;
  emoji: string;
  x: number;
}

export interface ClientMessage {
  type:
    | "join_room"
    | "leave_room"
    | "close_room"
    | "play"
    | "pause"
    | "seek"
    | "change_video"
    | "assign_role"
    | "remove_participant"
    | "chat_message"
    | "reaction"
    | "change_request"
    | "resolve_request"
    | "ping";
  payload?: any;
}
