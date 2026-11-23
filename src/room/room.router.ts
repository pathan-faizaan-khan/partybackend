import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { createRoom, getRoomByCode, getOrCreateParticipant, getParticipants } from "./room.service";

export const roomRouter = Router();

// Create room
roomRouter.post("/", authenticate, async (req, res) => {
  const user = req.user!;
  const { code, name } = req.body || {};

  const room = await createRoom(user.sub, user.username, code, name);
  res.status(201).json(room);
});

// Get room details by code
roomRouter.get("/:code", authenticate, async (req, res) => {
  const codeParam = req.params.code;
  const code = Array.isArray(codeParam) ? codeParam[0] : codeParam;

  if (!code) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }

  const room = await getRoomByCode(code);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.json(room);
});

// Get current user's membership in room
roomRouter.get("/:code/participants/me", authenticate, async (req, res) => {
  const codeParam = req.params.code;
  const code = Array.isArray(codeParam) ? codeParam[0] : codeParam;
  const user = req.user!;

  if (!code) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }

  const room = await getRoomByCode(code);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const membership = await getOrCreateParticipant(room.id, user.sub, user.username);
  res.json(membership);
});

// List room participants
roomRouter.get("/:code/participants", authenticate, async (req, res) => {
  const codeParam = req.params.code;
  const code = Array.isArray(codeParam) ? codeParam[0] : codeParam;

  if (!code) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }

  const room = await getRoomByCode(code);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const participants = await getParticipants(room.id);
  res.json(participants);
});
