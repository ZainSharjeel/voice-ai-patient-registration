/**
 * Realtime speech-to-text from the microphone, on Viktor's speech service.
 *
 * Framework-agnostic: React apps use `useRealtimeTranscription`; anything
 * else calls `startRealtimeTranscription` with a `getSession` that runs the
 * `viktorSpeech.startTranscription` Convex action. The browser streams 16 kHz
 * mono PCM16 to Viktor over one WebSocket and gets partial transcripts while
 * the person speaks and a final one per utterance. No vendor key is involved
 * on the client: the session URL carries a single-use ticket.
 */

import {
  CANT_REACH_MESSAGE,
  CANT_REACH_RETRYING_MESSAGE,
} from "../../../convex/viktorSpeechErrors";

export { CANT_REACH_MESSAGE, CANT_REACH_RETRYING_MESSAGE };

export type TranscriptionSession = { url: string };

export type TranscriptionState =
  | "idle"
  | "connecting"
  | "retrying"
  | "listening"
  | "stopping"
  | "ended"
  | "error"
  | "unreachable"
  | "unavailable";

/** Shown when the session's ticket is refused twice (it expired before the socket opened). */
export const SESSION_EXPIRED_MESSAGE =
  "The transcription session expired before it started. Try again.";
/** Shown when an open session's connection drops without the server ending it. */
export const CONNECTION_LOST_MESSAGE =
  "The transcription connection was lost. Try again.";

/**
 * Why a session could not be minted. `unavailable` only when Viktor said the
 * feature is off on this deployment; `unreachable` when the request failed,
 * timed out or got no usable answer (retried); `refused` for a stated reason
 * such as limits or credits (shown, never retried).
 */
export type SessionErrorKind = "unavailable" | "unreachable" | "refused";

const TICKET_REJECTED_CLOSE_CODE = 4401;
const UNAVAILABLE_CLOSE_CODE = 4503;
const ABNORMAL_CLOSE_CODE = 1006;

export class SessionTimeoutError extends Error {
  constructor() {
    super(CANT_REACH_MESSAGE);
    this.name = "SessionTimeoutError";
  }
}

/** The speech socket closed with `code` before the session was ready. */
export class SessionRefusedError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(
      code === TICKET_REJECTED_CLOSE_CODE
        ? SESSION_EXPIRED_MESSAGE
        : CANT_REACH_MESSAGE,
    );
    this.name = "SessionRefusedError";
    this.code = code;
  }
}

const LEFT_DURING_START_MESSAGE =
  "Transcription start was aborted: the page was hidden or left.";

/** True when the page was hidden or left while the session was still opening. */
function isLeftDuringStart(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError" &&
    error.message === LEFT_DURING_START_MESSAGE
  );
}

export function describeSessionError(error: unknown): {
  kind: SessionErrorKind;
  message: string;
} {
  if (error instanceof SessionTimeoutError) {
    return { kind: "unreachable", message: CANT_REACH_MESSAGE };
  }
  if (error instanceof SessionRefusedError) {
    return error.code === TICKET_REJECTED_CLOSE_CODE
      ? { kind: "refused", message: SESSION_EXPIRED_MESSAGE }
      : { kind: "unreachable", message: CANT_REACH_MESSAGE };
  }
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    const { kind, message } = data as { kind?: unknown; message?: unknown };
    if (
      (kind === "unavailable" ||
        kind === "unreachable" ||
        kind === "refused") &&
      typeof message === "string"
    ) {
      return { kind, message };
    }
  }
  if (typeof data === "string" && data)
    return { kind: "refused", message: data };
  return {
    kind: "refused",
    message:
      error instanceof Error ? error.message : "Could not start transcription.",
  };
}

const isFailed = (state: TranscriptionState) =>
  state === "error" || state === "unreachable" || state === "unavailable";
/** True once a session has ended or failed: nothing is streaming or pending. */
export const isOver = (state: TranscriptionState) =>
  state === "ended" || isFailed(state);

export type TranscriptionEnd = { reason: string; audioSeconds: number };

export type RealtimeTranscriptionOptions = {
  /** Mints a session; usually `() => startTranscription({})` (Convex action). */
  getSession: () => Promise<TranscriptionSession>;
  /** A mint that takes longer than this counts as unreachable. Default 15 s. */
  sessionTimeoutMs?: number;
  /**
   * A socket that has not said `ready` this long after it was opened counts as
   * unreachable and is retried. Default 20 s: the server answers within 14 s.
   */
  readyTimeoutMs?: number;
  /** Waits before each retry of an unreachable mint. Default 1, 2 and 4 s. */
  retryDelaysMs?: number[];
  /** Called when a retry is scheduled; `retryNow` skips the wait ("Try again"). */
  onRetrying?: (retry: { attempt: number; retryNow: () => void }) => void;
  /** An existing audio stream to transcribe instead of the default microphone. */
  stream?: MediaStream;
  /** Constraints for the microphone when no `stream` is given. */
  audio?: MediaTrackConstraints;
  /** Aborting it cancels a start in progress or closes a running session. */
  signal?: AbortSignal;
  /**
   * Stop when the page is hidden (tab switched, phone locked) and abort when it
   * is unloaded, so a forgotten microphone is not streamed and billed. Default true.
   */
  stopWhenHidden?: boolean;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStateChange?: (state: TranscriptionState) => void;
  onError?: (message: string, code: string) => void;
  onEnd?: (end: TranscriptionEnd) => void;
};

export type RealtimeTranscriber = {
  /** Ends the current utterance now; its final transcript follows. */
  commit: () => void;
  /** Stops the microphone, waits for the last final transcript, closes. */
  stop: () => Promise<void>;
  /** Closes immediately without waiting for a final transcript. */
  abort: () => void;
};

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES_100MS = 1600;
const MAX_FRAMES_QUEUED_BEFORE_READY = 100;
const STOP_TIMEOUT_MS = 6000;
const SESSION_TIMEOUT_MS = 15000;
const READY_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const WORKLET_NAME = "viktor-pcm16-downsampler";
const WORKLET_SOURCE = `
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_SAMPLE_RATE};
    this.frame = new Int16Array(${FRAME_SAMPLES_100MS});
    this.filled = 0;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const length = input[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (let c = 0; c < input.length; c++) sample += input[c][i];
      this.sum += sample / input.length;
      this.count++;
      this.position += 1;
      if (this.position < this.ratio) continue;
      this.position -= this.ratio;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.frame[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      this.sum = 0;
      this.count = 0;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(${FRAME_SAMPLES_100MS});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", Pcm16Downsampler);
`;

type ServerMessage =
  | { type: "ready"; session_id: string; max_session_seconds: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: string; audio_seconds: number };

export function isRealtimeTranscriptionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * Starts listening. Call it from a click or tap handler: mobile browsers only
 * start audio from a user gesture, so the audio context is created before the
 * first await.
 */
export async function startRealtimeTranscription(
  options: RealtimeTranscriptionOptions,
): Promise<RealtimeTranscriber> {
  const context = new AudioContext({ latencyHint: "interactive" });
  void context.resume();

  let state: TranscriptionState = "idle";
  let socket: WebSocket | null = null;
  let ownedStream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let ready = false;
  let ended = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });
  const queued: ArrayBuffer[] = [];

  const setState = (next: TranscriptionState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const releaseAudio = () => {
    worklet?.port.close();
    worklet?.disconnect();
    source?.disconnect();
    for (const track of ownedStream?.getTracks() ?? []) track.stop();
    worklet = null;
    source = null;
    ownedStream = null;
    if (context.state !== "closed") void context.close();
  };

  let detachLifecycle = () => {};
  const minting = new AbortController();
  const finish = (next: TranscriptionState) => {
    minting.abort();
    detachLifecycle();
    releaseAudio();
    if (!isFailed(state)) setState(next);
    resolveClosed();
  };

  const closeSocket = () => {
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  };

  const fail = (
    message: string,
    code: string,
    next: TranscriptionState = "error",
  ) => {
    options.onError?.(message, code);
    finish(next);
    closeSocket();
  };

  const sendFrame = (frame: ArrayBuffer) => {
    if (ready && socket?.readyState === WebSocket.OPEN) {
      socket.send(frame);
    } else if (queued.length < MAX_FRAMES_QUEUED_BEFORE_READY) {
      queued.push(frame);
    }
  };

  const mintOnce = () =>
    new Promise<TranscriptionSession>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SessionTimeoutError()),
        options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS,
      );
      const cancel = () => {
        clearTimeout(timer);
        reject(
          new DOMException("Transcription start was aborted.", "AbortError"),
        );
      };
      minting.signal.addEventListener("abort", cancel, { once: true });
      options
        .getSession()
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          minting.signal.removeEventListener("abort", cancel);
        });
    });

  const waitBeforeRetry = (delayMs: number, attempt: number) =>
    new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        minting.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      minting.signal.addEventListener("abort", done, { once: true });
      options.onRetrying?.({ attempt, retryNow: done });
    });

  let capturing: Promise<unknown> = Promise.resolve();
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  let attempt = 0;
  let expiredLast = false;
  const isExpired = (error: unknown) =>
    error instanceof SessionRefusedError &&
    error.code === TICKET_REJECTED_CLOSE_CODE;
  /** The single budget: is a failed open attempt worth another try? */
  const canRetry = (error: unknown) =>
    !minting.signal.aborted &&
    attempt < delays.length &&
    (isExpired(error)
      ? !expiredLast
      : describeSessionError(error).kind === "unreachable");

  /**
   * Connects to a minted session. Resolves once the server says `ready`;
   * rejects with `SessionRefusedError` when the socket is refused before that
   * (4401 expired ticket, 4503 or 1006 unreachable) and the budget allows
   * another try; otherwise it fails the session right away. Later closes end
   * the session here: "connection lost" unless it was stopping or ended.
   */
  const connect = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const opening = new WebSocket(url);
      socket = opening;
      socket.binaryType = "arraybuffer";
      const notReady = setTimeout(() => {
        if (ready || isOver(state)) return;
        opening.onclose = null;
        opening.onmessage = null;
        opening.close();
        const timedOut = new SessionTimeoutError();
        if (canRetry(timedOut)) {
          reject(timedOut);
        } else {
          failToOpen(timedOut);
          resolve();
        }
      }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      socket.onmessage = event => {
        onMessage(event);
        if (ready) {
          clearTimeout(notReady);
          resolve();
        }
      };
      socket.onclose = event => {
        clearTimeout(notReady);
        if (ended || isOver(state) || state === "stopping") {
          finish("ended");
          resolve();
        } else if (
          !ready &&
          (event.code === TICKET_REJECTED_CLOSE_CODE ||
            event.code === UNAVAILABLE_CLOSE_CODE ||
            event.code === ABNORMAL_CLOSE_CODE)
        ) {
          const refused = new SessionRefusedError(event.code);
          if (canRetry(refused)) {
            reject(refused);
          } else {
            failToOpen(refused);
            resolve();
          }
        } else {
          fail(CONNECTION_LOST_MESSAGE, `closed_${event.code}`);
          resolve();
        }
      };
    });

  /**
   * Opens a session as one step (mint, connect, `ready`) inside one retry
   * budget: an unreachable mint or socket waits `retryDelaysMs` and tries
   * again; an expired ticket is re-minted at once, but not twice in a row.
   * `onConnected` runs when the first socket is created.
   */
  const openSession = async (onConnected: () => void) => {
    for (; ; attempt++) {
      try {
        const { url } = await mintOnce();
        await capturing;
        if (minting.signal.aborted || options.signal?.aborted) return;
        const opened = connect(url);
        onConnected();
        await opened;
        return;
      } catch (error) {
        if (!canRetry(error)) throw error;
        const expired = isExpired(error);
        expiredLast = expired;
        if (expired) continue;
        setState("retrying");
        await waitBeforeRetry(delays[attempt], attempt + 1);
        if (minting.signal.aborted) throw error;
        setState("connecting");
      }
    }
  };

  /** The one place a session that could not open becomes a failed state. */
  const failToOpen = (error: unknown) => {
    const denied =
      error instanceof DOMException && error.name === "NotAllowedError";
    const { kind, message } = describeSessionError(error);
    if (denied) fail("Microphone access was denied.", "microphone_denied");
    else if (isExpired(error)) fail(SESSION_EXPIRED_MESSAGE, "session_expired");
    else if (kind === "refused") fail(message, "start_failed");
    else fail(message, kind, kind);
  };

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as ServerMessage;
    switch (message.type) {
      case "ready":
        ready = true;
        for (const frame of queued.splice(0)) socket?.send(frame);
        if (state === "connecting") setState("listening");
        break;
      case "partial":
        options.onPartial?.(message.text);
        break;
      case "final":
        options.onFinal?.(message.text);
        break;
      case "error":
        options.onError?.(message.message, message.code);
        ended = true;
        finish("error");
        socket?.close();
        break;
      case "ended":
        ended = true;
        options.onEnd?.({
          reason: message.reason,
          audioSeconds: message.audio_seconds,
        });
        break;
    }
  };

  // Hiding or leaving the page also counts while the session is still
  // opening (a pending mint or a retry's wait), not only once it streams.
  let leaveStart = () => {};
  const leftDuringStart = new Promise<"left">(resolve => {
    leaveStart = () => resolve("left");
  });
  let onHidden = leaveStart;
  let onLeave = leaveStart;
  if (options.stopWhenHidden !== false && typeof document !== "undefined") {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHidden();
    };
    const onPageHide = () => onLeave();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    detachLifecycle = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }

  setState("connecting");
  try {
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    const microphone = options.stream
      ? Promise.resolve(options.stream)
      : navigator.mediaDevices
          .getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...options.audio,
            },
          })
          .then(granted => {
            if (isOver(state)) {
              for (const track of granted.getTracks()) track.stop();
            } else {
              ownedStream = granted;
            }
            return granted;
          });
    const workletLoaded = context.audioWorklet
      .addModule(workletUrl)
      .finally(() => URL.revokeObjectURL(workletUrl));
    capturing = Promise.all([microphone, workletLoaded]).then(
      async ([stream]) => {
        if (context.state !== "running") await context.resume();
        if (isOver(state) || options.signal?.aborted) {
          return;
        }
        source = context.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(context, WORKLET_NAME);
        worklet.port.onmessage = event => sendFrame(event.data as ArrayBuffer);
        const silentSink = context.createGain();
        silentSink.gain.value = 0;
        source
          .connect(worklet)
          .connect(silentSink)
          .connect(context.destination);
      },
    );
    capturing.catch(() => {});
    let connectedOnce = false;
    const firstSocket = new Promise<void>((resolve, reject) => {
      const connected = () => {
        connectedOnce = true;
        resolve();
      };
      openSession(connected).catch(error => {
        reject(error);
        if (connectedOnce && !minting.signal.aborted) failToOpen(error);
      });
    });
    const startup = Promise.all([firstSocket, capturing]);
    startup.catch(() => {});
    let stopWaiting = () => {};
    const aborted = new Promise<"aborted">(resolve => {
      if (options.signal?.aborted) resolve("aborted");
      stopWaiting = () => resolve("aborted");
      options.signal?.addEventListener("abort", stopWaiting, { once: true });
    });
    const started = await Promise.race([startup, aborted, leftDuringStart]);
    options.signal?.removeEventListener("abort", stopWaiting);
    if (started === "left") {
      throw new DOMException(LEFT_DURING_START_MESSAGE, "AbortError");
    }
    if (started === "aborted" || options.signal?.aborted) {
      throw new DOMException("Transcription start was aborted.", "AbortError");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      finish("ended");
      closeSocket();
      throw error;
    }
    failToOpen(error);
    throw error;
  }

  const send = (payload: { type: "commit" | "stop" }) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(payload));
  };

  const abort = () => {
    ended = true;
    socket?.close();
    finish("ended");
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const stop = async () => {
    if (isOver(state)) return;
    if (!ready || socket?.readyState !== WebSocket.OPEN) {
      abort();
      return;
    }
    setState("stopping");
    releaseAudio();
    send({ type: "stop" });
    const timeout = new Promise<void>(resolve =>
      setTimeout(resolve, STOP_TIMEOUT_MS),
    );
    await Promise.race([closed, timeout]);
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    finish("ended");
  };

  onHidden = () => void stop();
  onLeave = abort;

  return { commit: () => send({ type: "commit" }), stop, abort };
}

export type TranscriptionView = {
  state: TranscriptionState;
  partial: string;
  finals: string[];
  error: string | null;
};

export const INITIAL_TRANSCRIPTION_VIEW: TranscriptionView = {
  state: "idle",
  partial: "",
  finals: [],
  error: null,
};

type ControllerSessionOptions = Omit<
  RealtimeTranscriptionOptions,
  "signal" | "onStateChange" | "onRetrying" | "onPartial" | "onError"
>;

/**
 * The state machine behind `useRealtimeTranscription`, without React: one
 * session at a time, its transcript and error, and `retry` for a "Try again"
 * button. `getOptions` is read at each start; `onChange` gets every new view.
 */
export function createTranscriptionController(
  getOptions: () => ControllerSessionOptions,
  onChange: (view: TranscriptionView) => void,
) {
  let view = INITIAL_TRANSCRIPTION_VIEW;
  let transcriber: RealtimeTranscriber | null = null;
  let starting: AbortController | null = null;
  let retryNow: (() => void) | null = null;

  const update = (patch: Partial<TranscriptionView>) => {
    view = { ...view, ...patch };
    onChange(view);
  };

  const start = async () => {
    if (transcriber || starting) return;
    const controller = new AbortController();
    starting = controller;
    update({ error: null, partial: "" });
    const options = getOptions();
    try {
      const started = await startRealtimeTranscription({
        ...options,
        signal: controller.signal,
        onStateChange: next => {
          if (next !== "retrying") retryNow = null;
          if (next === "retrying") {
            update({ state: next, error: CANT_REACH_RETRYING_MESSAGE });
          } else if (next === "connecting") {
            // a retry's next attempt keeps saying it is retrying
            update({
              state: next,
              error: view.state === "retrying" ? view.error : null,
            });
          } else if (next === "listening" && view.state !== "listening") {
            update({ state: next, error: null });
          } else if (view.error === CANT_REACH_RETRYING_MESSAGE) {
            // a stopped or hidden reconnect is no longer retrying
            update({ state: next, error: null });
          } else {
            update({ state: next });
          }
          if (isOver(next)) transcriber = null;
        },
        onRetrying: ({ retryNow: skipWait }) => {
          retryNow = skipWait;
        },
        onPartial: partial => update({ partial }),
        onFinal: text => {
          update({ partial: "", finals: [...view.finals, text] });
          options.onFinal?.(text);
        },
        onError: message => update({ error: message }),
      });
      transcriber = isOver(view.state) ? null : started;
    } catch (error) {
      if (controller.signal.aborted || isLeftDuringStart(error)) {
        // stopped, or the page was hidden or left before it was listening
        update({ state: "idle", error: null });
      } else if (!view.error) {
        update({ error: describeSessionError(error).message });
      }
    } finally {
      starting = null;
    }
  };

  /** "Try again": retries a waiting request now, or starts over after it gave up. */
  const retry = () => {
    if (retryNow) retryNow();
    else void start();
  };

  const stop = async () => {
    starting?.abort();
    await transcriber?.stop();
    update({ partial: "" });
  };

  return {
    start,
    stop,
    retry,
    commit: () => transcriber?.commit(),
    reset: () => update({ finals: [], partial: "", error: null }),
    dispose: () => {
      starting?.abort();
      transcriber?.abort();
    },
  };
}
