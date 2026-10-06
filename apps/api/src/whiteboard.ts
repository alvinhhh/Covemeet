import { z } from "zod";
import { HttpError } from "./security.js";

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const itemId = z.string().uuid();
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const whiteboardInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stroke"),
      epoch,
      id: itemId,
      points: z
        .array(z.tuple([coordinate, coordinate]))
        .min(2)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      epoch,
      id: itemId,
      x: coordinate,
      y: coordinate,
      text: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ kind: z.literal("delete"), epoch, targetId: itemId }).strict(),
  z.object({ kind: z.literal("clear"), epoch }).strict(),
  z
    .object({ kind: z.literal("policy"), epoch, readOnly: z.boolean() })
    .strict(),
]);

export type WhiteboardInput = z.infer<typeof whiteboardInput>;
export type WhiteboardAccess = {
  scope: string;
  authorId: string;
  host: boolean;
};
export type WhiteboardEvent = WhiteboardInput & {
  seq: number;
  authorId: string;
};
export type WhiteboardPage = {
  events: WhiteboardEvent[];
  cursor: number;
  hasMore: boolean;
  readOnly: boolean;
  epoch: number;
};

export const WHITEBOARD_PAGE_SIZE = 256;
export const WHITEBOARD_EVENT_LIMIT = 10_000;
export const WHITEBOARD_BYTE_LIMIT = 12 * 1024 * 1024;

export function whiteboardEventSize(event: WhiteboardEvent) {
  return Buffer.byteLength(JSON.stringify(event));
}

export function sameWhiteboardItem(
  existing: WhiteboardEvent,
  input: Extract<WhiteboardInput, { kind: "stroke" | "text" }>,
  authorId: string,
) {
  return (
    existing.authorId === authorId &&
    existing.epoch === input.epoch &&
    existing.kind === input.kind &&
    (input.kind === "stroke"
      ? existing.kind === "stroke" &&
        JSON.stringify(existing.points) === JSON.stringify(input.points)
      : existing.kind === "text" &&
        existing.x === input.x &&
        existing.y === input.y &&
        existing.text === input.text)
  );
}

export function authorizeWhiteboardWrite(
  readOnly: boolean,
  access: WhiteboardAccess,
  input: WhiteboardInput,
) {
  if ((input.kind === "clear" || input.kind === "policy") && !access.host)
    throw new HttpError(403, "Host permission required");
  if (readOnly && !access.host && input.kind !== "policy")
    throw new HttpError(403, "Whiteboard editing is disabled");
}
