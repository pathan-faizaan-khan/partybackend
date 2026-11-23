/**
 * PartyWatch database schema (Supabase Postgres + Drizzle ORM)
 *
 * Mapped 1:1 to agents.md:
 *  - Rooms with unique codes/links ................ rooms, room_invites
 *  - Users / user sessions / auth (bonus) ......... users, user_sessions
 *  - Roles: Host / Moderator / Participant / Viewer room_participants (+ role_changes audit)
 *  - Real-time sync_state ......................... room_playback_state, room_video_history
 *  - WebSocket connections ........................ room_connections
 *  - Role enforcement (rejected events) ........... room_events (outcome + rejection_reason)
 *  - Participants must request changes ............ change_requests
 *  - Basic chat (bonus) ........................... chat_messages
 *  - Reactions on key moments (bonus) ............. room_reactions
 *  - Persistent rooms / scalability (bonus) ....... rooms.is_persistent, room_connections.server_instance_id
 *
 * Identity note: the `userId` in every WebSocket payload is users.id.
 * A person's per-room name and role live on room_participants.
 */
import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    check,
    doublePrecision,
    index,
    inet,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    varchar,
} from "drizzle-orm/pg-core";

/* ───────────────────────── Shared constants & enums ───────────────────────── */

export const ROOM_ROLES = ["host", "moderator", "participant", "viewer"] as const;
export const PARTICIPANT_STATUSES = ["active", "left", "removed"] as const;
export const ROOM_STATUSES = ["active", "closed"] as const;
export const PLAY_STATES = ["playing", "paused"] as const;
export const CHANGE_REQUEST_TYPES = ["play", "pause", "seek", "change_video"] as const;
export const CHANGE_REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export const ROLE_CHANGE_REASONS = ["joined", "assigned", "host_transferred"] as const;
export const EVENT_OUTCOMES = ["accepted", "rejected"] as const;
export const ROOM_EVENT_TYPES = [
    "room_created",
    "room_closed",
    "join_room",
    "leave_room",
    "play",
    "pause",
    "seek",
    "change_video",
    "assign_role",
    "remove_participant",
    "transfer_host",
    "change_request_created",
    "change_request_resolved",
] as const;

export type RoomRole = (typeof ROOM_ROLES)[number];

export const roomRole = pgEnum("room_role", ROOM_ROLES);
export const participantStatus = pgEnum("participant_status", PARTICIPANT_STATUSES);
export const roomStatus = pgEnum("room_status", ROOM_STATUSES);
export const playState = pgEnum("play_state", PLAY_STATES);
export const changeRequestType = pgEnum("change_request_type", CHANGE_REQUEST_TYPES);
export const changeRequestStatus = pgEnum("change_request_status", CHANGE_REQUEST_STATUSES);
export const roleChangeReason = pgEnum("role_change_reason", ROLE_CHANGE_REASONS);
export const eventOutcome = pgEnum("event_outcome", EVENT_OUTCOMES);
export const roomEventType = pgEnum("room_event_type", ROOM_EVENT_TYPES);

/**
 * Role permission matrix from agents.md. Enforce it in the WebSocket server
 * before processing any event (reject and log the attempt in room_events).
 * `manageRoles` for moderators additionally requires rooms.moderators_can_manage.
 */
export const ROLE_PERMISSIONS = {
    host: { control: true, changeVideo: true, assignRoles: true, removeParticipants: true, transferHost: true },
    moderator: { control: true, changeVideo: true, assignRoles: false, removeParticipants: false, transferHost: false },
    participant: { control: false, changeVideo: false, assignRoles: false, removeParticipants: false, transferHost: false },
    viewer: { control: false, changeVideo: false, assignRoles: false, removeParticipants: false, transferHost: false },
} as const satisfies Record<RoomRole, Record<string, boolean>>;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
    timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date());

const YOUTUBE_ID_REGEX = sql.raw(`'^[A-Za-z0-9_-]{11}$'`);

/* ─────────────────────────────── Users & sessions ─────────────────────────────── */

/** Guests (just a username on join_room) and registered users (auth bonus). */
export const users = pgTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        /** Link to Supabase Auth (auth.users.id). Null for guests. Not a DB-level FK on purpose. */
        authUserId: uuid("auth_user_id").unique(),
        username: varchar("username", { length: 50 }).notNull(),
        email: text("email").unique(),
        avatarUrl: text("avatar_url"),
        passwordHash: text("password_hash"),
        isGuest: boolean("is_guest").notNull().default(true),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t: any) => [check("users_username_not_blank", sql`char_length(btrim(${t.username})) >= 1`)],
);

/** Login / guest sessions (agents.md: "user sessions"). Store only a hash of the token. */
export const userSessions = pgTable(
    "user_sessions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        tokenHash: text("token_hash").notNull().unique(),
        userAgent: text("user_agent"),
        ipAddress: inet("ip_address"),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
        revokedAt: timestamp("revoked_at", { withTimezone: true }),
        createdAt: createdAt(),
    },
    (t) => [index("user_sessions_user_idx").on(t.userId), index("user_sessions_expires_idx").on(t.expiresAt)],
);

/* ──────────────────────────────────── Rooms ──────────────────────────────────── */

export const rooms = pgTable(
    "rooms",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        /** Short join code, also used in the share link (/room/<code>). */
        code: varchar("code", { length: 12 }).notNull().unique(),
        name: varchar("name", { length: 100 }).notNull(),
        description: text("description"),
        /** Original creator. The current Host is the participant with role = 'host' (can change via transfer). */
        createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
        status: roomStatus("status").notNull().default("active"),
        /** Persistent rooms (bonus): keep the room and its state after everyone leaves. */
        isPersistent: boolean("is_persistent").notNull().default(false),
        /** Scalability target: 50+ users per room. */
        maxParticipants: integer("max_participants").notNull().default(100),
        chatEnabled: boolean("chat_enabled").notNull().default(true),
        reactionsEnabled: boolean("reactions_enabled").notNull().default(true),
        /** agents.md: moderators "may optionally manage roles/participants if you choose". */
        moderatorsCanManage: boolean("moderators_can_manage").notNull().default(false),
        lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
        closedAt: timestamp("closed_at", { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [
        check("rooms_code_format", sql`${t.code} ~ '^[A-Z0-9]{4,12}$'`),
        check("rooms_max_participants_positive", sql`${t.maxParticipants} > 0`),
        index("rooms_created_by_idx").on(t.createdBy),
        index("rooms_status_last_active_idx").on(t.status, t.lastActiveAt),
    ],
);

/** Optional rotating / expiring invite links on top of rooms.code. */
export const roomInvites = pgTable(
    "room_invites",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        code: varchar("code", { length: 32 }).notNull().unique(),
        createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
        maxUses: integer("max_uses"),
        useCount: integer("use_count").notNull().default(0),
        expiresAt: timestamp("expires_at", { withTimezone: true }),
        revokedAt: timestamp("revoked_at", { withTimezone: true }),
        createdAt: createdAt(),
    },
    (t) => [
        check("room_invites_use_count_valid", sql`${t.useCount} >= 0 AND (${t.maxUses} IS NULL OR ${t.useCount} <= ${t.maxUses})`),
        index("room_invites_room_idx").on(t.roomId),
    ],
);

/* ───────────────────────── Membership, roles & presence ───────────────────────── */

/** One row per user per room. Rejoining reuses the row; roles live here. */
export const roomParticipants = pgTable(
    "room_participants",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** join_room { username }: the name shown in this room. */
        username: varchar("username", { length: 50 }).notNull(),
        role: roomRole("role").notNull().default("participant"),
        status: participantStatus("status").notNull().default("active"),
        isOnline: boolean("is_online").notNull().default(false),
        /** Set when the Host removes someone; lets the app decide whether they may rejoin. */
        isBanned: boolean("is_banned").notNull().default(false),
        joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
        leftAt: timestamp("left_at", { withTimezone: true }),
        removedAt: timestamp("removed_at", { withTimezone: true }),
        removedBy: uuid("removed_by").references(() => users.id, { onDelete: "set null" }),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [
        uniqueIndex("room_participants_room_user_uq").on(t.roomId, t.userId),
        /** Exactly one active Host per room, enforced by the database. */
        uniqueIndex("room_participants_one_active_host_uq")
            .on(t.roomId)
            .where(sql`${t.role} = 'host' AND ${t.status} = 'active'`),
        index("room_participants_room_status_idx").on(t.roomId, t.status),
        index("room_participants_user_idx").on(t.userId),
        check("room_participants_removed_has_time", sql`${t.status} <> 'removed' OR ${t.removedAt} IS NOT NULL`),
    ],
);

/** Every role assignment / host transfer (UI history + audit). */
export const roleChanges = pgTable(
    "role_changes",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
        changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
        fromRole: roomRole("from_role"),
        toRole: roomRole("to_role").notNull(),
        reason: roleChangeReason("reason").notNull().default("assigned"),
        createdAt: createdAt(),
    },
    (t) => [index("role_changes_room_idx").on(t.roomId, t.createdAt), index("role_changes_target_idx").on(t.targetUserId)],
);

/** One row per WebSocket connection. server_instance_id supports horizontal scaling. */
export const roomConnections = pgTable(
    "room_connections",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        participantId: uuid("participant_id").notNull().references(() => roomParticipants.id, { onDelete: "cascade" }),
        socketId: text("socket_id").notNull(),
        serverInstanceId: text("server_instance_id"),
        userAgent: text("user_agent"),
        ipAddress: inet("ip_address"),
        connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
        lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
        disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
        disconnectReason: text("disconnect_reason"),
    },
    (t) => [
        uniqueIndex("room_connections_socket_uq").on(t.socketId),
        index("room_connections_participant_idx").on(t.participantId),
        index("room_connections_live_idx").on(t.roomId).where(sql`${t.disconnectedAt} IS NULL`),
    ],
);

/* ───────────────────────────── Playback & video history ───────────────────────────── */

/** The sync_state { playState, currentTime, videoId }. Exactly one row per room. */
export const roomPlaybackState = pgTable(
    "room_playback_state",
    {
        roomId: uuid("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade" }),
        videoId: varchar("video_id", { length: 11 }),
        playState: playState("play_state").notNull().default("paused"),
        /** Named position_seconds to avoid the SQL keyword CURRENT_TIME. Position at state_updated_at. */
        currentTime: doublePrecision("position_seconds").notNull().default(0),
        /** When position was captured. While playing, clients add (now - this) to extrapolate. */
        stateUpdatedAt: timestamp("state_updated_at", { withTimezone: true }).notNull().defaultNow(),
        /** Increments on every accepted change so clients can drop stale sync_state messages. */
        version: bigint("version", { mode: "number" }).notNull().default(0),
        updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    },
    (t) => [
        check("room_playback_position_non_negative", sql`${t.currentTime} >= 0`),
        check("room_playback_video_id_format", sql`${t.videoId} IS NULL OR ${t.videoId} ~ ${YOUTUBE_ID_REGEX}`),
    ],
);

/** Every change_video (pasted YouTube URL). */
export const roomVideoHistory = pgTable(
    "room_video_history",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        videoId: varchar("video_id", { length: 11 }).notNull(),
        sourceUrl: text("source_url"),
        title: text("title"),
        changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
        startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
        endedAt: timestamp("ended_at", { withTimezone: true }),
    },
    (t) => [
        check("room_video_history_video_id_format", sql`${t.videoId} ~ ${YOUTUBE_ID_REGEX}`),
        index("room_video_history_room_idx").on(t.roomId, t.startedAt),
    ],
);

/* ──────────────────── Participant change requests (approval flow) ──────────────────── */

/** agents.md: "Participant must request admin/mod to approve any changes". */
export const changeRequests = pgTable(
    "change_requests",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        requesterId: uuid("requester_id").references(() => users.id, { onDelete: "set null" }),
        type: changeRequestType("type").notNull(),
        /** For type = 'seek'. */
        requestedTime: doublePrecision("requested_time"),
        /** For type = 'change_video'. */
        requestedVideoId: varchar("requested_video_id", { length: 11 }),
        requestedVideoUrl: text("requested_video_url"),
        status: changeRequestStatus("status").notNull().default("pending"),
        resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
        resolvedAt: timestamp("resolved_at", { withTimezone: true }),
        resolutionNote: text("resolution_note"),
        createdAt: createdAt(),
    },
    (t) => [
        check(
            "change_requests_payload_matches_type",
            sql`(${t.type} <> 'seek' OR ${t.requestedTime} IS NOT NULL) AND (${t.type} <> 'change_video' OR ${t.requestedVideoId} IS NOT NULL)`,
        ),
        check("change_requests_resolved_has_time", sql`${t.status} = 'pending' OR ${t.resolvedAt} IS NOT NULL`),
        index("change_requests_room_status_idx").on(t.roomId, t.status, t.createdAt),
        index("change_requests_requester_idx").on(t.requesterId),
    ],
);

/* ───────────────────────────── Chat & reactions (bonus) ───────────────────────────── */

export const chatMessages = pgTable(
    "chat_messages",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
        /** Snapshot, so history still reads correctly after a rename or leave. */
        username: varchar("username", { length: 50 }).notNull(),
        body: text("body").notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
        deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
        createdAt: createdAt(),
    },
    (t) => [
        check("chat_messages_body_length", sql`char_length(${t.body}) BETWEEN 1 AND 2000`),
        index("chat_messages_room_idx").on(t.roomId, t.id),
    ],
);

/** Emoji reactions, optionally pinned to a moment in the video. */
export const roomReactions = pgTable(
    "room_reactions",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
        emoji: varchar("emoji", { length: 16 }).notNull(),
        videoId: varchar("video_id", { length: 11 }),
        videoTimeSeconds: doublePrecision("video_time_seconds"),
        createdAt: createdAt(),
    },
    (t) => [
        check("room_reactions_time_non_negative", sql`${t.videoTimeSeconds} IS NULL OR ${t.videoTimeSeconds} >= 0`),
        index("room_reactions_room_idx").on(t.roomId, t.createdAt),
        index("room_reactions_moment_idx").on(t.roomId, t.videoId, t.videoTimeSeconds),
    ],
);

/* ─────────────────────────────── Audit / event log ─────────────────────────────── */

/**
 * Append-only log of every WebSocket action, including REJECTED ones
 * (e.g. a Participant sending change_video), per "Role Enforcement".
 */
export const roomEvents = pgTable(
    "room_events",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
        roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
        actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
        /** For assign_role, remove_participant, transfer_host. */
        targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
        type: roomEventType("type").notNull(),
        outcome: eventOutcome("outcome").notNull().default("accepted"),
        rejectionReason: text("rejection_reason"),
        payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
        createdAt: createdAt(),
    },
    (t) => [
        check("room_events_rejection_has_reason", sql`${t.outcome} = 'accepted' OR ${t.rejectionReason} IS NOT NULL`),
        index("room_events_room_idx").on(t.roomId, t.id),
        index("room_events_room_type_idx").on(t.roomId, t.type),
        index("room_events_actor_idx").on(t.actorId),
    ],
);

/* ───────────────────────────────── Inferred types ───────────────────────────────── */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSession = typeof userSessions.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type RoomInvite = typeof roomInvites.$inferSelect;
export type RoomParticipant = typeof roomParticipants.$inferSelect;
export type NewRoomParticipant = typeof roomParticipants.$inferInsert;
export type RoleChange = typeof roleChanges.$inferSelect;
export type RoomConnection = typeof roomConnections.$inferSelect;
export type RoomPlaybackState = typeof roomPlaybackState.$inferSelect;
export type RoomVideoHistory = typeof roomVideoHistory.$inferSelect;
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type RoomReaction = typeof roomReactions.$inferSelect;
export type RoomEvent = typeof roomEvents.$inferSelect;