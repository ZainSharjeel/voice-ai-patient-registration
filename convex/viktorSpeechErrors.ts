/**
 * How `startTranscription` words a failed mint. The browser client reads
 * `kind` from the ConvexError data: only `unavailable` (the backend said the
 * feature is off) reads as "not available"; `unreachable` (no answer, a 404 or
 * a 5xx: Viktor down, restarting, or older than this template) is retried.
 */
export type TranscriptionStartErrorData = {
  kind: "unavailable" | "unreachable" | "refused";
  message: string;
};

export const TRANSCRIPTION_NOT_AVAILABLE_MESSAGE =
  "Live transcription is not available on this Viktor deployment.";
/** Shown while an unreachable session request is retried. */
export const CANT_REACH_RETRYING_MESSAGE =
  "Can't reach transcription, retrying…";
/** Shown once the retries are used up; offer a "Try again" that calls start. */
export const CANT_REACH_MESSAGE = "Can't reach transcription. Try again.";

export function transcriptionUnreachable(): TranscriptionStartErrorData {
  return { kind: "unreachable", message: CANT_REACH_MESSAGE };
}

export function transcriptionStartError(
  status: number,
  detail: unknown,
): TranscriptionStartErrorData {
  if (status === 501) {
    return {
      kind: "unavailable",
      message: TRANSCRIPTION_NOT_AVAILABLE_MESSAGE,
    };
  }
  if (status === 404 || status === 408 || status >= 500) {
    return transcriptionUnreachable();
  }
  if (typeof detail === "string" && detail) {
    return { kind: "refused", message: detail };
  }
  return {
    kind: "refused",
    message: `Could not start transcription (HTTP ${status}).`,
  };
}
