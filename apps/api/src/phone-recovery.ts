import { createHash } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ServerError, type RoomServiceClient } from "livekit-server-sdk";
import {
  phoneSupervisorInputSchema,
  type PhoneSupervisor,
  type PhoneSupervisorInput,
  type PhoneDialogService,
} from "./phone-dialogs.js";
import type { PgStore } from "./store.js";

const unavailable = () =>
  new Error("Managed phone recovery remains unresolved");
const roles = ["supervisor", "pbx", "sip"] as const;
const containerSchema = z.object({
  Id: z.string().regex(/^[0-9a-f]{64}$/),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({
    Running: z.boolean(),
    Restarting: z.boolean(),
    StartedAt: z.string().max(80),
  }),
});
type DockerRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<unknown>;

/** Only the host management process gets this socket. Never mount it in the
 * phone supervisor or expose these methods through the phone HTTP API. */
export class PhoneDockerManager {
  constructor(private send: DockerRequest = dockerRequest) {}
  private async daemon(expected?: string) {
    const { ID } = z
      .object({ ID: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/) })
      .parse(await this.send("GET", "/info"));
    if (expected && expected !== ID) throw unavailable();
    return ID;
  }
  private async container(
    claim: PhoneSupervisorInput,
    role: (typeof roles)[number],
  ) {
    if (!claim.runtime) throw unavailable();
    const id = claim.runtime[role];
    const raw = await this.send("GET", `/containers/${id}/json`);
    if (raw === undefined) return;
    const value = containerSchema.parse(raw),
      labels = value.Config.Labels;
    if (
      value.Id !== id ||
      labels["com.docker.compose.project"] !== claim.runtime.project ||
      labels["io.covemeet.phone.pbx"] !== claim.pbxId ||
      labels["io.covemeet.phone.owner"] !== claim.ownerId ||
      labels["io.covemeet.phone.role"] !== role
    )
      throw unavailable();
    return value;
  }
  async inspect(raw: PhoneSupervisorInput): Promise<void> {
    const claim = phoneSupervisorInputSchema.parse(raw);
    if (!claim.runtime) throw unavailable();
    await this.daemon(claim.runtime.daemonId);
    for (const role of roles) {
      const container = await this.container(claim, role);
      if (
        !container ||
        container.State.Restarting ||
        (role !== "supervisor" && !container.State.Running)
      )
        throw unavailable();
      if (
        role === "pbx" &&
        phonePbxEpoch(container.Id, container.State.StartedAt) !==
          claim.pbxEpoch
      )
        throw unavailable();
    }
  }
  async fence(raw: PhoneSupervisor): Promise<void> {
    const claim = phoneSupervisorInputSchema.parse({
      pbxId: raw.pbxId,
      ownerId: raw.ownerId,
      pbxEpoch: raw.pbxEpoch,
      runtime: raw.runtime,
    });
    if (!claim.runtime || raw.state !== "fencing") throw unavailable();
    await this.daemon(claim.runtime.daemonId);
    // Validate all extant resources before the first mutation. An absent exact
    // immutable container ID on the same daemon is a prior completed fence,
    // unlike a missing ARI channel that an in-flight request may still create.
    for (const role of roles) await this.container(claim, role);
    for (const role of roles) {
      const container = await this.container(claim, role);
      if (!container) continue;
      await this.send("POST", `/containers/${container.Id}/update`, {
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      });
      await this.send(
        "DELETE",
        `/containers/${container.Id}?force=true&v=false`,
      );
      if (await this.container(claim, role)) throw unavailable();
    }
    await this.daemon(claim.runtime.daemonId);
    for (const role of roles)
      if (await this.container(claim, role)) throw unavailable();
  }
}
export function phonePbxEpoch(containerId: string, startedAt: string) {
  if (
    !/^[0-9a-f]{64}$/.test(containerId) ||
    !Number.isFinite(Date.parse(startedAt)) ||
    Date.parse(startedAt) <= 0
  )
    throw unavailable();
  return createHash("sha256")
    .update(`${containerId}:${startedAt}`)
    .digest("hex");
}
async function dockerRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (part: Buffer) => {
          bytes += part.length;
          if (bytes > 262144) req.destroy(unavailable());
          else chunks.push(part);
        });
        res.on("error", () => reject(unavailable()));
        res.on("end", () => {
          if (
            res.statusCode === 404 &&
            method === "GET" &&
            /^\/containers\/[0-9a-f]{64}\/json$/.test(path)
          ) {
            resolve(undefined);
            return;
          }
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(unavailable());
            return;
          }
          try {
            resolve(
              bytes
                ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
                : undefined,
            );
          } catch {
            reject(unavailable());
          }
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(unavailable()));
    req.on("error", () => reject(unavailable()));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

type RecoveryStage =
  | "validate-input"
  | "fence-runtime"
  | "replacement-identity"
  | "replacement-runtime"
  | "list-dialogs"
  | "dialog-owner"
  | "revoke-meeting"
  | "journal-unknown"
  | "discover-holding"
  | "holding-owner"
  | "list-holding-peers"
  | "native-peer-owner"
  | "remove-native-peer"
  | "wait-relay-expiry"
  | "verify-holding-absence"
  | "finish-dialog"
  | "refence-runtime"
  | "recheck-replacement"
  | "replace-claim";

/** Fixed labels only: callers can record where recovery stopped without
 * logging raw SDK errors, room names, participant IDs, or credentials. */
export class PhoneRecoveryError extends Error {
  constructor(
    readonly stage: RecoveryStage,
    readonly orphanFailures: RecoveryStage[] = [],
  ) {
    super("Managed phone recovery remains unresolved");
    this.name = "PhoneRecoveryError";
  }
}

type RecoveryStore = Pick<
  PgStore,
  | "getPhoneSupervisor"
  | "fencePhoneSupervisor"
  | "replacePhoneSupervisor"
  | "queryPhoneDialogs"
>;
type RecoveryRooms = Pick<
  RoomServiceClient,
  "listRooms" | "listParticipants" | "removeParticipant"
>;
export async function fenceManagedPhone(
  store: RecoveryStore,
  manager: PhoneDockerManager,
  pbxId: string,
  expectedOwnerId: string,
) {
  const current = await store.getPhoneSupervisor(pbxId);
  if (!current?.runtime || current.ownerId !== expectedOwnerId)
    throw unavailable();
  const fenced = await store.fencePhoneSupervisor(current);
  await manager.fence(fenced);
  return fenced;
}

/** Called from an independent manager against the existing database and SFU.
 * Restarting processes or changing labels alone never invokes this transition. */
export async function recoverManagedPhone(
  store: RecoveryStore,
  dialogs: Pick<PhoneDialogService, "stop" | "finish">,
  rooms: RecoveryRooms,
  manager: PhoneDockerManager,
  replacement: PhoneSupervisorInput,
  previousOwnerId: string,
): Promise<PhoneSupervisor> {
  let stage: RecoveryStage = "validate-input";
  try {
    replacement = phoneSupervisorInputSchema.parse(replacement);
    stage = "fence-runtime";
    const fenced = await fenceManagedPhone(
      store,
      manager,
      replacement.pbxId,
      previousOwnerId,
    );
    stage = "replacement-identity";
    if (
      !replacement.runtime ||
      replacement.ownerId === fenced.ownerId ||
      replacement.pbxEpoch === fenced.pbxEpoch ||
      replacement.runtime.daemonId !== fenced.runtime!.daemonId ||
      replacement.runtime.project !== fenced.runtime!.project ||
      roles.some((role) =>
        Object.values(fenced.runtime!).includes(replacement.runtime![role]),
      )
    )
      throw unavailable();
    stage = "replacement-runtime";
    await manager.inspect(replacement);
    stage = "list-dialogs";
    const records = await store.queryPhoneDialogs({ pbxId: fenced.pbxId });
    if (records.length > 20) throw unavailable();
    const failures: RecoveryStage[] = [];
    for (const dialog of records) {
      try {
        stage = "dialog-owner";
        if (
          dialog.ownerId !== fenced.ownerId ||
          dialog.pbxEpoch !== fenced.pbxEpoch
        )
          throw unavailable();
        // Revocation is useful even when a sticky unknown prevents release.
        stage = "revoke-meeting";
        const stopped = await dialogs.stop(dialog.callId, {
          ownerId: dialog.ownerId,
          revision: dialog.revision,
        });
        stage = "journal-unknown";
        if (
          stopped.uncertain ||
          Object.values(stopped.operations).some(
            (s) => s === "pending" || s === "unknown",
          )
        )
          throw unavailable();
        // A destroyed PBX and SIP process cannot finish a delayed native request.
        // SFU deletion remains scoped to the durably recorded room and peer SIDs.
        stage = "discover-holding";
        const matches = (await rooms.listRooms()).filter((r) =>
          r.name.startsWith(`phone-hold-${dialog.callId}_`),
        );
        if (matches.length > 1) throw unavailable();
        for (const room of matches) {
          stage = "holding-owner";
          const holding = dialog.holding;
          if (
            !holding ||
            room.name !== holding.roomName ||
            room.sid !== holding.roomSid
          )
            throw unavailable();
          // LiveKit 1.13.7 waits 10s for ICE disconnection, another 5s for
          // failure, then 5s for participant cleanup. Five seconds here raced
          // that normal remote expiry after the worker was forcibly removed.
          // Timeout still retains the reservation; it never authorizes deletion.
          for (let attempt = 0; attempt <= 300; attempt++) {
            stage = "list-holding-peers";
            const peers = await rooms
              .listParticipants(room.name)
              .catch((error) => {
                if (error instanceof ServerError && error.code === "not_found")
                  return [];
                throw unavailable();
              });
            if (!peers.length) break;
            for (const peer of peers) {
              if (peer.identity === `cm-relay-${dialog.callId}`) continue; // Wait for the fenced worker's RTC connection to expire; never adopt an unrecorded SID.
              stage = "native-peer-owner";
              if (
                peer.sid !== holding.nativeSid ||
                peer.identity !== holding.nativeIdentity ||
                peer.kind !== 3 ||
                peer.attributes["sip.trunkID"] !== dialog.sipTrunkId ||
                peer.attributes["sip.ruleID"] !== dialog.sipRuleId
              )
                throw unavailable();
              stage = "remove-native-peer";
              await rooms.removeParticipant(room.name, peer.identity);
            }
            stage = "wait-relay-expiry";
            if (attempt === 300) throw unavailable();
            await delay(100);
          }
        }
        // Re-read the recorded scope after deletions. A changed room SID or any
        // remaining peer blocks completion even after an earlier empty snapshot.
        stage = "verify-holding-absence";
        const remainingRooms = (await rooms.listRooms()).filter((r) =>
          r.name.startsWith(`phone-hold-${dialog.callId}_`),
        );
        if (remainingRooms.length > 1) throw unavailable();
        for (const room of remainingRooms) {
          if (
            !dialog.holding ||
            room.sid !== dialog.holding.roomSid ||
            room.name !== dialog.holding.roomName
          )
            throw unavailable();
          const remaining = await rooms
            .listParticipants(room.name)
            .catch((error) => {
              if (error instanceof ServerError && error.code === "not_found")
                return [];
              throw unavailable();
            });
          if (remaining.length) throw unavailable();
        }
        stage = "finish-dialog";
        await dialogs.finish(stopped.callId, {
          ownerId: stopped.ownerId,
          revision: stopped.revision,
          proof: {
            allocationsStopped: true,
            callerAbsent: true,
            outboundAbsent: true,
            bridgeAbsent: true,
            nativeAbsent: true,
            holdingRelayAbsent: true,
            rtcClosed: true,
          },
        });
      } catch {
        // One ambiguous call must not prevent revocation of other orphan calls.
        // Its own journal and reservation remain unresolved.
        failures.push(stage);
      }
    }
    if (failures.length) throw new PhoneRecoveryError(failures[0]!, failures);
    // Recheck both immutable old IDs and the new boot before the atomic transfer.
    stage = "refence-runtime";
    await manager.fence(fenced);
    stage = "recheck-replacement";
    await manager.inspect(replacement);
    stage = "replace-claim";
    return await store.replacePhoneSupervisor(fenced, replacement);
  } catch (error) {
    if (error instanceof PhoneRecoveryError) throw error;
    throw new PhoneRecoveryError(stage);
  }
}
