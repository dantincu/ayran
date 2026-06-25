import { Router } from "express";
import type { Response } from "express";
import { type AuthedRequest, endSession, issueSession, loginWithFilen, requireAuth } from "./auth.js";
import {
  createStream,
  deleteStream,
  getStream,
  listStreamsForAccount,
  setHostPaused,
} from "./store.js";

export const router = Router();

router.post("/auth/login", async (req, res) => {
  const { email, password, twoFactorCode } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  try {
    const account = await loginWithFilen(email, password, twoFactorCode);
    const token = issueSession(account);
    res.json({ token, account });
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : "Filen login failed" });
  }
});

router.post("/auth/logout", requireAuth, (req: AuthedRequest, res: Response) => {
  const header = req.headers.authorization!;
  endSession(header.slice("Bearer ".length));
  res.status(204).end();
});

router.get("/streams", requireAuth, (req: AuthedRequest, res) => {
  res.json(listStreamsForAccount(req.account!.userId));
});

router.post("/streams", requireAuth, (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.status(201).json(createStream(name.trim(), req.account!.userId));
});

router.delete("/streams/:id", requireAuth, (req: AuthedRequest, res) => {
  const ok = deleteStream((req.params.id as string), req.account!.userId);
  if (!ok) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  res.status(204).end();
});

router.post("/streams/:id/pause", requireAuth, (req: AuthedRequest, res) => {
  const stream = getStream((req.params.id as string));
  if (!stream || stream.ownerAccountId !== req.account!.userId) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  setHostPaused((req.params.id as string), req.account!.userId, true);
  res.status(204).end();
});

router.post("/streams/:id/resume", requireAuth, (req: AuthedRequest, res) => {
  const stream = getStream((req.params.id as string));
  if (!stream || stream.ownerAccountId !== req.account!.userId) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  setHostPaused((req.params.id as string), req.account!.userId, false);
  res.status(204).end();
});
