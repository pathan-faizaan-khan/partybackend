/**
 * Relations for Drizzle ORM 0.44.x (relations() API).
 *
 * Usage:  const db = drizzle(client, { schema: { ...schema, ...relations } });
 *         db.query.rooms.findFirst({ where: eq(...), with: { participants: true } })
 */
import { relations } from "drizzle-orm";
import {
  users,
  userSessions,
  rooms,
  roomInvites,
  roomParticipants,
  roleChanges,
  roomConnections,
  roomPlaybackState,
  roomVideoHistory,
  changeRequests,
  roomEvents,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(userSessions),
  memberships: many(roomParticipants),
  createdRooms: many(rooms),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  creator: one(users, { fields: [rooms.createdBy], references: [users.id] }),
  playback: one(roomPlaybackState, { fields: [rooms.id], references: [roomPlaybackState.roomId] }),
  participants: many(roomParticipants),
  invites: many(roomInvites),
  videoHistory: many(roomVideoHistory),
  changeRequests: many(changeRequests),
  roleChanges: many(roleChanges),
  events: many(roomEvents),
  connections: many(roomConnections),
}));

export const roomInvitesRelations = relations(roomInvites, ({ one }) => ({
  room: one(rooms, { fields: [roomInvites.roomId], references: [rooms.id] }),
  creator: one(users, { fields: [roomInvites.createdBy], references: [users.id] }),
}));

export const roomParticipantsRelations = relations(roomParticipants, ({ one, many }) => ({
  room: one(rooms, { fields: [roomParticipants.roomId], references: [rooms.id] }),
  user: one(users, { fields: [roomParticipants.userId], references: [users.id] }),
  removedByUser: one(users, {
    fields: [roomParticipants.removedBy],
    references: [users.id],
    relationName: "removedByUser",
  }),
  connections: many(roomConnections),
}));

export const roleChangesRelations = relations(roleChanges, ({ one }) => ({
  room: one(rooms, { fields: [roleChanges.roomId], references: [rooms.id] }),
  targetUser: one(users, { fields: [roleChanges.targetUserId], references: [users.id] }),
  changedByUser: one(users, {
    fields: [roleChanges.changedBy],
    references: [users.id],
    relationName: "changedByUser",
  }),
}));

export const roomConnectionsRelations = relations(roomConnections, ({ one }) => ({
  room: one(rooms, { fields: [roomConnections.roomId], references: [rooms.id] }),
  participant: one(roomParticipants, {
    fields: [roomConnections.participantId],
    references: [roomParticipants.id],
  }),
}));

export const roomPlaybackStateRelations = relations(roomPlaybackState, ({ one }) => ({
  room: one(rooms, { fields: [roomPlaybackState.roomId], references: [rooms.id] }),
  updatedByUser: one(users, { fields: [roomPlaybackState.updatedBy], references: [users.id] }),
}));

export const roomVideoHistoryRelations = relations(roomVideoHistory, ({ one }) => ({
  room: one(rooms, { fields: [roomVideoHistory.roomId], references: [rooms.id] }),
  changedByUser: one(users, { fields: [roomVideoHistory.changedBy], references: [users.id] }),
}));

export const changeRequestsRelations = relations(changeRequests, ({ one }) => ({
  room: one(rooms, { fields: [changeRequests.roomId], references: [rooms.id] }),
  requester: one(users, { fields: [changeRequests.requesterId], references: [users.id] }),
  resolver: one(users, {
    fields: [changeRequests.resolvedBy],
    references: [users.id],
    relationName: "resolver",
  }),
}));





export const roomEventsRelations = relations(roomEvents, ({ one }) => ({
  room: one(rooms, { fields: [roomEvents.roomId], references: [rooms.id] }),
  actor: one(users, { fields: [roomEvents.actorId], references: [users.id] }),
  target: one(users, {
    fields: [roomEvents.targetUserId],
    references: [users.id],
    relationName: "eventTarget",
  }),
}));
