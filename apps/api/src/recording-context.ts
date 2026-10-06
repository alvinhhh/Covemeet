import type { RecordingContext } from "@meeting-platform/recording";
import type { Meeting, Recording } from "./store.js";

/** The marker is fixed when a recording is reserved; absent means pre-migration. */
export function recordingContext(m: Meeting, r: Recording): RecordingContext {
  let tenantId: string;
  if (r.contextVersion === undefined || r.contextVersion === 1) {
    tenantId = "installation";
  } else if (r.contextVersion === 2) {
    const owner = m.hosted?.billingOwnerId;
    if (
      !owner ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner)
    )
      throw new Error("Recording tenant binding is unavailable");
    tenantId = `hosted-owner:${owner}`;
  } else {
    throw new Error("Unsupported recording context version");
  }
  return { tenantId, meetingId: m.id, recordingId: r.id };
}
