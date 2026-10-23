import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import {
  TRANSCRIPTION_NOT_AVAILABLE_MESSAGE,
  transcriptionStartError,
  transcriptionUnreachable,
} from "../convex/viktorSpeechErrors";
import {
  CANT_REACH_MESSAGE,
  CANT_REACH_RETRYING_MESSAGE,
  CONNECTION_LOST_MESSAGE,
  createTranscriptionController,
  SESSION_EXPIRED_MESSAGE,
  startRealtimeTranscription,
  type TranscriptionView,
} from "../src/lib/viktor-speech/realtimeTranscription";

const ROOT = join(import.meta.dir, "..");

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: (ArrayBuffer | string)[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: ArrayBuffer | string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  serverSends(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class FakeWorkletNode {
  static last: FakeWorkletNode;
  port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    close() {},
  };
  constructor() {
    FakeWorkletNode.last = this;
  }
  connect(next: unknown) {
    return next;
  }
  disconnect() {}
  emit(frame: ArrayBuffer) {
    this.port.onmessage?.({ data: frame });
  }
}

const node = () => ({
  connect: (next: unknown) => next,
  disconnect() {},
  gain: { value: 1 },
});
const stopped: string[] = [];

class FakeAudioContext {
  static last: FakeAudioContext;
  state = "running";
  resumes = 0;
  audioWorklet = { addModule: async () => {} };
  destination = node();
  constructor() {
    FakeAudioContext.last = this;
  }
  resume = async () => {
    this.resumes++;
    this.state = "running";
  };
  close = async () => {
    this.state = "closed";
  };
  createMediaStreamSource = () => node();
  createGain = () => node();
}

const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let micDenied = false;

class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  hide() {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
let fakeDocument = new FakeDocument();
let fakeWindow = new EventTarget();

beforeEach(() => {
  FakeSocket.instances = [];
  stopped.length = 0;
  micDenied = false;
  for (const name of [
    "WebSocket",
    "AudioContext",
    "AudioWorkletNode",
    "navigator",
    "document",
    "window",
  ]) {
    saved[name] = globals[name];
  }
  fakeDocument = new FakeDocument();
  fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  globals.WebSocket = FakeSocket;
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeWorkletNode;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          if (micDenied) throw new DOMException("denied", "NotAllowedError");
          return { getTracks: () => [{ stop: () => stopped.push("mic") }] };
        },
      },
    },
  });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

const session = async () => ({
  url: "wss://api.example/api/viktor-spaces/realtime-transcription/stream?ticket=t",
});

describe("startRealtimeTranscription", () => {
  test("streams queued and live audio, reports partials and finals, flushes on stop", async () => {
    const events: string[] = [];
    const transcriber = await startRealtimeTranscription({
      getSession: session,
      onStateChange: state => events.push(`state:${state}`),
      onPartial: text => events.push(`partial:${text}`),
      onFinal: text => events.push(`final:${text}`),
      onEnd: end => events.push(`end:${end.reason}`),
    });
    const [socket] = FakeSocket.instances;
    expect(socket.url).toContain("ticket=t");
    expect(socket.binaryType).toBe("arraybuffer");

    const early = new Int16Array(1600).buffer;
    FakeWorkletNode.last.emit(early);
    expect(socket.sent).toEqual([]);
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    expect(socket.sent).toEqual([early]);
    const live = new Int16Array(1600).buffer;
    FakeWorkletNode.last.emit(live);
    expect(socket.sent[1]).toBe(live);

    socket.serverSends({ type: "partial", text: "hello" });
    socket.serverSends({ type: "final", text: "hello world" });

    const stopping = transcriber.stop();
    expect(stopped).toEqual(["mic"]);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    socket.serverSends({
      type: "ended",
      reason: "client_stop",
      audio_seconds: 0.2,
    });
    socket.close();
    await stopping;

    expect(events).toEqual([
      "state:connecting",
      "state:listening",
      "partial:hello",
      "final:hello world",
      "state:stopping",
      "end:client_stop",
      "state:ended",
    ]);
  });

  test("speech during a slow mint is captured and sent once ready", async () => {
    let mint: (value: Awaited<ReturnType<typeof session>>) => void = () => {};
    const starting = startRealtimeTranscription({
      getSession: () =>
        new Promise(resolve => {
          mint = resolve;
        }),
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const early = new Int16Array(1600).buffer;
    FakeWorkletNode.last.emit(early);

    mint(await session());
    await starting;
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });

    expect(socket.sent[0]).toBe(early);
  });

  test("reports a denied microphone without opening a socket", async () => {
    micDenied = true;
    const errors: string[] = [];

    await expect(
      startRealtimeTranscription({
        getSession: session,
        onError: (_message, code) => errors.push(code),
      }),
    ).rejects.toThrow();

    expect(errors).toEqual(["microphone_denied"]);
    expect(FakeSocket.instances).toEqual([]);
  });

  test("a failed mint turns the granted microphone off", async () => {
    const errors: string[] = [];

    await expect(
      startRealtimeTranscription({
        getSession: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          throw new Error("This workspace is out of Viktor credits.");
        },
        onError: (_message, code) => errors.push(code),
      }),
    ).rejects.toThrow("out of Viktor credits");

    expect(errors).toEqual(["start_failed"]);
    expect(stopped).toEqual(["mic"]);
    expect(FakeSocket.instances).toEqual([]);
  });

  test("aborting during connect opens no socket and frees the microphone", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const starting = startRealtimeTranscription({
      signal: controller.signal,
      getSession: async () => {
        controller.abort();
        return session();
      },
      onStateChange: state => states.push(state),
    });

    await expect(starting).rejects.toThrow("aborted");
    expect(FakeSocket.instances).toEqual([]);
    expect(stopped).toEqual(["mic"]);
    expect(states).toEqual(["connecting", "ended"]);
  });

  test("aborting while the mint hangs frees the microphone at once", async () => {
    const controller = new AbortController();
    const starting = startRealtimeTranscription({
      signal: controller.signal,
      getSession: () => new Promise(() => {}),
    });
    await new Promise(resolve => setTimeout(resolve, 5));

    controller.abort();

    await expect(starting).rejects.toThrow("aborted");
    expect(stopped).toEqual(["mic"]);
    expect(FakeSocket.instances).toEqual([]);
  });

  test("an audio context suspended across the start is resumed", async () => {
    await startRealtimeTranscription({
      getSession: async () => {
        FakeAudioContext.last.state = "suspended";
        return session();
      },
    });

    expect(FakeAudioContext.last.state).toBe("running");
    expect(FakeAudioContext.last.resumes).toBe(2);
  });

  test("aborting while the audio context resumes still cancels the start", async () => {
    const controller = new AbortController();
    const starting = startRealtimeTranscription({
      signal: controller.signal,
      getSession: async () => {
        const context = FakeAudioContext.last;
        context.state = "suspended";
        context.resume = async () => {
          controller.abort();
          context.state = "running";
        };
        return session();
      },
    });

    await expect(starting).rejects.toThrow("aborted");
    expect(FakeSocket.instances).toEqual([]);
    expect(stopped).toEqual(["mic"]);
  });

  test("aborting a running session closes it", async () => {
    const controller = new AbortController();
    await startRealtimeTranscription({
      getSession: session,
      signal: controller.signal,
    });
    const [socket] = FakeSocket.instances;

    controller.abort();

    expect(socket.readyState).toBe(3);
    expect(stopped).toEqual(["mic"]);
  });

  test("stopping before the server is ready closes without sending", async () => {
    const errors: string[] = [];
    const transcriber = await startRealtimeTranscription({
      getSession: session,
      onError: (_message, code) => errors.push(code),
    });
    const [socket] = FakeSocket.instances;
    socket.send = () => {
      throw new DOMException("still connecting", "InvalidStateError");
    };

    await transcriber.stop();

    expect(socket.readyState).toBe(3);
    expect(stopped).toEqual(["mic"]);
    expect(errors).toEqual([]);
  });

  test("a server error frame frees the mic and closes the socket", async () => {
    const errors: string[] = [];
    const states: string[] = [];
    await startRealtimeTranscription({
      getSession: session,
      onError: (_message, code) => errors.push(code),
      onStateChange: state => states.push(state),
    });
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });

    socket.serverSends({
      type: "error",
      code: "out_of_credits",
      message: "This workspace is out of credits.",
    });

    expect(errors).toEqual(["out_of_credits"]);
    expect(states.at(-1)).toBe("error");
    expect(stopped).toEqual(["mic"]);
    expect(socket.readyState).toBe(3);
  });

  test("an unexpected close is an error in plain words, not a silent end", async () => {
    const errors: string[] = [];
    await startRealtimeTranscription({
      getSession: session,
      onError: (message, code) => errors.push(`${code}:${message}`),
    });
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    socket.readyState = 3;
    socket.onclose?.({ code: 4503, reason: "unavailable" });

    expect(errors).toEqual([`closed_4503:${CONNECTION_LOST_MESSAGE}`]);
    expect(stopped).toEqual(["mic"]);
  });
});

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const refuse = (socket: FakeSocket, code: number, reason: string) => {
  socket.readyState = 3;
  socket.onclose?.({ code, reason });
};

describe("a refused speech socket", () => {
  test("a transient outage (4503) is retried with a new ticket, then listens", async () => {
    const states: string[] = [];
    let mints = 0;
    await startRealtimeTranscription({
      getSession: () => {
        mints++;
        return session();
      },
      retryDelaysMs: [0, 0],
      onStateChange: state => states.push(state),
    });

    refuse(FakeSocket.instances[0], 4503, "unavailable");
    await tick();
    const retried = FakeSocket.instances[1];
    retried.readyState = FakeSocket.OPEN;
    retried.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });

    expect(mints).toBe(2);
    expect(states).toEqual([
      "connecting",
      "retrying",
      "connecting",
      "listening",
    ]);
    expect(stopped).toEqual([]);
  });

  test("an outage that outlasts the retries ends as unreachable in plain words", async () => {
    const errors: string[] = [];
    const states: string[] = [];
    await startRealtimeTranscription({
      getSession: session,
      retryDelaysMs: [0],
      onStateChange: state => states.push(state),
      onError: (message, code) => errors.push(`${code}:${message}`),
    });

    refuse(FakeSocket.instances[0], 4503, "unavailable");
    await tick();
    refuse(FakeSocket.instances[1], 1006, "");

    expect(states.at(-1)).toBe("unreachable");
    expect(errors).toEqual([`unreachable:${CANT_REACH_MESSAGE}`]);
    expect(errors.join()).not.toContain(": unavailable");
    expect(stopped).toEqual(["mic"]);
  });

  test("an expired ticket (4401) is re-minted once silently, then said plainly", async () => {
    const errors: string[] = [];
    const states: string[] = [];
    let mints = 0;
    await startRealtimeTranscription({
      getSession: () => {
        mints++;
        return session();
      },
      onStateChange: state => states.push(state),
      onError: (message, code) => errors.push(`${code}:${message}`),
    });

    refuse(FakeSocket.instances[0], 4401, "invalid or expired ticket");
    await tick();
    expect(mints).toBe(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(errors).toEqual([]);

    refuse(FakeSocket.instances[1], 4401, "invalid or expired ticket");

    expect(errors).toEqual([`session_expired:${SESSION_EXPIRED_MESSAGE}`]);
    expect(states).toEqual(["connecting", "error"]);
    expect(stopped).toEqual(["mic"]);
  });
});

describe("useRealtimeTranscription's controller", () => {
  const unreachable = () =>
    Promise.reject(
      Object.assign(new Error("convex"), { data: transcriptionUnreachable() }),
    );

  test("retry() skips a retry's wait, and after giving up starts over", async () => {
    const views: TranscriptionView[] = [];
    let getSession: () => Promise<{ url: string }> = unreachable;
    let mints = 0;
    const controller = createTranscriptionController(
      () => ({
        getSession: () => {
          mints++;
          return getSession();
        },
        retryDelaysMs: [60_000, 60_000],
      }),
      view => views.push(view),
    );

    const first = controller.start();
    await tick();
    expect(views.at(-1)).toMatchObject({
      state: "retrying",
      error: CANT_REACH_RETRYING_MESSAGE,
    });
    controller.retry();
    await tick();
    controller.retry();
    await first;
    expect(mints).toBe(3);
    expect(views.at(-1)).toMatchObject({
      state: "unreachable",
      error: CANT_REACH_MESSAGE,
    });

    getSession = session;
    controller.retry();
    await tick();
    expect(mints).toBe(4);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(views.at(-1)).toMatchObject({ state: "connecting", error: null });
    controller.dispose();
  });

  test("a final is added to the transcript and stop clears the partial", async () => {
    const views: TranscriptionView[] = [];
    const finals: string[] = [];
    const controller = createTranscriptionController(
      () => ({ getSession: session, onFinal: text => finals.push(text) }),
      view => views.push(view),
    );
    await controller.start();
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    socket.serverSends({ type: "partial", text: "hel" });
    socket.serverSends({ type: "final", text: "hello" });
    socket.serverSends({ type: "partial", text: "wor" });

    const stopping = controller.stop();
    socket.serverSends({
      type: "ended",
      reason: "client_stop",
      audio_seconds: 1,
    });
    socket.close();
    await stopping;

    expect(finals).toEqual(["hello"]);
    expect(views.at(-1)).toMatchObject({
      state: "ended",
      partial: "",
      finals: ["hello"],
    });
  });
});

describe("page lifecycle", () => {
  const ready = async (options = {}) => {
    const transcriber = await startRealtimeTranscription({
      getSession: session,
      ...options,
    });
    const socket = FakeSocket.instances.at(-1) as FakeSocket;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    return { transcriber, socket };
  };

  test("a hidden tab or locked phone stops the session and frees the mic", async () => {
    const { socket } = await ready();

    fakeDocument.hide();

    expect(stopped).toEqual(["mic"]);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
  });

  test("navigating away aborts the session", async () => {
    const { socket } = await ready();

    fakeWindow.dispatchEvent(new Event("pagehide"));

    expect(socket.readyState).toBe(3);
    expect(stopped).toEqual(["mic"]);
  });

  test("stopWhenHidden: false keeps streaming in the background", async () => {
    const { socket } = await ready({ stopWhenHidden: false });

    fakeDocument.hide();

    expect(stopped).toEqual([]);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });

  test("an ended session detaches its listeners and a new start works", async () => {
    const first = await ready();
    first.socket.serverSends({
      type: "ended",
      reason: "idle",
      audio_seconds: 0,
    });
    first.socket.close();

    const second = await ready();
    fakeDocument.hide();

    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.socket.sent).not.toContain(JSON.stringify({ type: "stop" }));
    expect(second.socket.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
  });
});

/** What a Convex client throws for a ConvexError: the action's data rides along. */
const convexError = (data: { kind: string; message: string }) =>
  Object.assign(new Error("[CONVEX A(viktorSpeech:startTranscription)]"), {
    data,
  });

describe("honest start states", () => {
  test("only a backend that says the feature is off reads as not available", async () => {
    const states: string[] = [];
    const errors: string[] = [];
    let mints = 0;

    await expect(
      startRealtimeTranscription({
        getSession: async () => {
          mints++;
          throw convexError(transcriptionStartError(501, "off"));
        },
        retryDelaysMs: [0, 0],
        onStateChange: state => states.push(state),
        onError: (message, code) => errors.push(`${code}:${message}`),
      }),
    ).rejects.toThrow();

    expect(mints).toBe(1);
    expect(states).toEqual(["connecting", "unavailable"]);
    expect(errors).toEqual([
      `unavailable:${TRANSCRIPTION_NOT_AVAILABLE_MESSAGE}`,
    ]);
    expect(stopped).toEqual(["mic"]);
    expect(FakeSocket.instances).toEqual([]);
  });

  test("a failing or timed-out token request shows Can't reach, retrying, and Try again retries at once", async () => {
    const states: string[] = [];
    const retries: number[] = [];
    let mints = 0;

    await startRealtimeTranscription({
      getSession: () => {
        mints++;
        if (mints === 1) return new Promise(() => {});
        if (mints === 2)
          return Promise.reject(convexError(transcriptionUnreachable()));
        return session();
      },
      sessionTimeoutMs: 10,
      retryDelaysMs: [60_000, 60_000],
      onStateChange: state => states.push(state),
      onRetrying: ({ attempt, retryNow }) => {
        retries.push(attempt);
        retryNow();
      },
    });

    expect(mints).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(states).toEqual([
      "connecting",
      "retrying",
      "connecting",
      "retrying",
      "connecting",
    ]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("once the retries are used up the state is unreachable, never not available", async () => {
    const states: string[] = [];
    const errors: string[] = [];

    await expect(
      startRealtimeTranscription({
        getSession: () =>
          Promise.reject(
            convexError(transcriptionStartError(404, "Not Found")),
          ),
        retryDelaysMs: [0],
        onStateChange: state => states.push(state),
        onError: (message, code) => errors.push(`${code}:${message}`),
      }),
    ).rejects.toThrow();

    expect(states).toEqual([
      "connecting",
      "retrying",
      "connecting",
      "unreachable",
    ]);
    expect(errors).toEqual([`unreachable:${CANT_REACH_MESSAGE}`]);
    expect(errors.join()).not.toContain("not available");
    expect(stopped).toEqual(["mic"]);
  });

  test("aborting while a retry waits frees the microphone and stops retrying", async () => {
    const controller = new AbortController();
    let mints = 0;
    const starting = startRealtimeTranscription({
      signal: controller.signal,
      getSession: () => {
        mints++;
        return Promise.reject(convexError(transcriptionUnreachable()));
      },
      retryDelaysMs: [20, 20],
      onRetrying: () => controller.abort(),
    });

    await expect(starting).rejects.toThrow("aborted");
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(mints).toBe(1);
    expect(stopped).toEqual(["mic"]);
  });

  test("the retrying message is short and says it is retrying", () => {
    expect(CANT_REACH_RETRYING_MESSAGE).toBe(
      "Can't reach transcription, retrying…",
    );
  });
});

describe("transcriptionStartError", () => {
  test("the backend saying the feature is off is the only not-available answer", () => {
    expect(transcriptionStartError(501, "off")).toEqual({
      kind: "unavailable",
      message: TRANSCRIPTION_NOT_AVAILABLE_MESSAGE,
    });
  });

  test("no route, a 5xx or a timeout reads as unreachable", () => {
    for (const status of [404, 408, 500, 502, 503, 504]) {
      expect(transcriptionStartError(status, "Not Found").kind).toBe(
        "unreachable",
      );
    }
    expect(transcriptionUnreachable().message).not.toContain("not available");
  });

  test("the server's own reason reaches the viewer", () => {
    expect(
      transcriptionStartError(
        402,
        "This workspace is out of credits. Add credits to use transcription.",
      ),
    ).toEqual({
      kind: "refused",
      message:
        "This workspace is out of credits. Add credits to use transcription.",
    });
    expect(transcriptionStartError(400, undefined).message).toBe(
      "Could not start transcription (HTTP 400).",
    );
  });
});

describe("viktorSpeech Convex action", () => {
  test("only a signed-in viewer can mint, and the viewer id is the session's", () => {
    const source = readFileSync(join(ROOT, "convex/viktorSpeech.ts"), "utf8");
    expect(source).toContain(
      "export const startTranscription = authenticatedAction(",
    );
    expect(source).not.toMatch(/\baction\(/);
    expect(source).toContain("viewer_id: ctx.userId");
  });

  test("a request that fails or times out is reported as unreachable", () => {
    const source = readFileSync(join(ROOT, "convex/viktorSpeech.ts"), "utf8");
    expect(source).toContain("signal: timeout.signal");
    expect(source).toContain(
      "throw new ConvexError(transcriptionUnreachable())",
    );
  });
});

describe("viktorSpeech on a template upgrade", () => {
  // A template upgrade adds viktorSpeech.ts to every Space but skips a
  // customised viktorTools.ts, so speech must bundle (Convex uses esbuild)
  // against any viktorTools, including one that exports nothing speech could use.
  test("it bundles against a viktorTools.ts that exports nothing", async () => {
    const result = await esbuild
      .build({
        entryPoints: [join(ROOT, "convex/viktorSpeech.ts")],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        plugins: [
          {
            name: "customised-viktor-tools",
            setup(build) {
              build.onResolve({ filter: /^\.\/viktorTools$/ }, () => ({
                path: "viktorTools",
                namespace: "customised",
              }));
              build.onLoad({ filter: /.*/, namespace: "customised" }, () => ({
                contents: "export {};",
                loader: "ts",
              }));
              build.onResolve(
                { filter: /^[^./]|^\.\/(functions|_generated\/)/ },
                args => ({ path: args.path, external: true }),
              );
            },
          },
        ],
      })
      .catch((error: { errors?: { text: string }[] }) => error);
    expect((result.errors ?? []).map(error => error.text)).toEqual([]);
  });

  test("it imports nothing from viktorTools.ts", () => {
    for (const file of ["viktorSpeech.ts", "viktorSpeechErrors.ts"]) {
      const source = readFileSync(join(ROOT, "convex", file), "utf8");
      expect(source).not.toMatch(/from\s+["']\.\/viktorTools["']/);
    }
  });
});

describe("one retry budget for opening a session", () => {
  test("a mint and socket that keep failing stop after the single loop's attempts", async () => {
    class RefusingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        setTimeout(() => refuse(this, 4503, "unavailable"), 0);
      }
    }
    globals.WebSocket = RefusingSocket;
    const states: string[] = [];
    const retryDelaysMs = [0, 0, 0];
    let mints = 0;
    await startRealtimeTranscription({
      getSession: () => {
        mints++;
        return mints % 2 === 1
          ? Promise.reject(convexError(transcriptionUnreachable()))
          : session();
      },
      retryDelaysMs,
      onStateChange: state => states.push(state),
    }).catch(() => {});
    for (let i = 0; i < 100 && states.at(-1) !== "unreachable"; i++)
      await tick();

    // every attempt starts with a mint; 79f3c362a5 nested two budgets (8 mints, 4 sockets)
    expect(states.at(-1)).toBe("unreachable");
    expect(mints).toBeLessThanOrEqual(retryDelaysMs.length + 1);
  });
});

describe("a speech socket that never says ready", () => {
  const waitFor = async (done: () => boolean, ms = 1000) => {
    const until = Date.now() + ms;
    while (!done() && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
  };

  test("is given up on and retried, then ends as unreachable instead of connecting forever", async () => {
    const states: string[] = [];
    const errors: string[] = [];
    let mints = 0;
    await startRealtimeTranscription({
      getSession: () => {
        mints++;
        return session();
      },
      readyTimeoutMs: 20,
      retryDelaysMs: [0],
      onStateChange: state => states.push(state),
      onError: (message, code) => errors.push(`${code}:${message}`),
    }).catch(() => {});
    await waitFor(() => states.at(-1) === "unreachable");

    expect(states).toEqual([
      "connecting",
      "retrying",
      "connecting",
      "unreachable",
    ]);
    expect(mints).toBe(2);
    expect(FakeSocket.instances.map(socket => socket.readyState)).toEqual([
      3, 3,
    ]);
    expect(errors).toEqual([`unreachable:${CANT_REACH_MESSAGE}`]);
    expect(stopped).toEqual(["mic"]);
  });

  test("a socket that says ready in time is kept", async () => {
    const states: string[] = [];
    await startRealtimeTranscription({
      getSession: session,
      readyTimeoutMs: 20,
      onStateChange: state => states.push(state),
    });
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(states).toEqual(["connecting", "listening"]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });

  test("while a retry's next attempt connects, the viewer still reads that it is retrying", async () => {
    const views: TranscriptionView[] = [];
    let mints = 0;
    const controller = createTranscriptionController(
      () => ({
        getSession: () => {
          mints++;
          return mints === 1
            ? Promise.reject(
                Object.assign(new Error("convex"), {
                  data: transcriptionUnreachable(),
                }),
              )
            : session();
        },
        retryDelaysMs: [0],
        readyTimeoutMs: 60_000,
      }),
      view => views.push(view),
    );
    void controller.start();
    await waitFor(() => FakeSocket.instances.length === 1);

    expect(views.at(-1)).toMatchObject({
      state: "connecting",
      error: CANT_REACH_RETRYING_MESSAGE,
    });
    const [socket] = FakeSocket.instances;
    socket.readyState = FakeSocket.OPEN;
    socket.serverSends({
      type: "ready",
      session_id: "s",
      max_session_seconds: 900,
    });
    await tick();
    expect(views.at(-1)).toMatchObject({ state: "listening", error: null });
    controller.dispose();
  });

  const reconnectingController = async () => {
    const views: TranscriptionView[] = [];
    let mints = 0;
    const controller = createTranscriptionController(
      () => ({
        getSession: () => {
          mints++;
          return mints === 1
            ? Promise.reject(
                Object.assign(new Error("convex"), {
                  data: transcriptionUnreachable(),
                }),
              )
            : session();
        },
        retryDelaysMs: [0],
        readyTimeoutMs: 60_000,
      }),
      view => views.push(view),
    );
    void controller.start();
    await waitFor(() => FakeSocket.instances.length === 1);
    expect(views.at(-1)).toMatchObject({
      state: "connecting",
      error: CANT_REACH_RETRYING_MESSAGE,
    });
    return { controller, views };
  };

  test("a reconnect that is stopped no longer says it is retrying", async () => {
    const { controller, views } = await reconnectingController();
    await controller.stop();
    await waitFor(() => views.at(-1)?.state !== "connecting");

    expect(views.at(-1)?.state).not.toBe("connecting");
    expect(views.at(-1)?.error ?? null).toBeNull();
    controller.dispose();
  });

  test("a reconnect stopped by hiding the page no longer says it is retrying", async () => {
    const { controller, views } = await reconnectingController();
    fakeDocument.hide();
    await waitFor(() => views.at(-1)?.state !== "connecting");

    expect(views.at(-1)?.state).not.toBe("connecting");
    expect(views.at(-1)?.error ?? null).toBeNull();
    controller.dispose();
  });
});

describe("hiding the page while a session is still opening", () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const unreachableOnce = () => {
    let mints = 0;
    return {
      mints: () => mints,
      getSession: () => {
        mints++;
        return mints === 1
          ? Promise.reject(convexError(transcriptionUnreachable()))
          : session();
      },
    };
  };

  test("hidden during a retry's wait: no socket, no microphone, no listening", async () => {
    const states: string[] = [];
    const mint = unreachableOnce();
    const starting = startRealtimeTranscription({
      getSession: mint.getSession,
      retryDelaysMs: [20],
      onStateChange: state => states.push(state),
      onRetrying: () => fakeDocument.hide(),
    });

    await expect(starting).rejects.toThrow("aborted");
    await settle();
    expect(mint.mints()).toBe(1);
    expect(FakeSocket.instances).toEqual([]);
    expect(states).not.toContain("listening");
    expect(states.at(-1)).toBe("ended");
    expect(stopped).toEqual(["mic"]);
  });

  test("hidden while the first token request is pending: no socket opens", async () => {
    const states: string[] = [];
    let release = () => {};
    const starting = startRealtimeTranscription({
      getSession: () =>
        new Promise<{ url: string }>(resolve => {
          release = () => void session().then(resolve);
        }),
      onStateChange: state => states.push(state),
    });
    fakeDocument.hide();
    release();

    await expect(starting).rejects.toThrow("aborted");
    await settle();
    expect(FakeSocket.instances).toEqual([]);
    expect(states).not.toContain("listening");
    expect(stopped).toEqual(["mic"]);
  });

  test("the viewer is back to idle with no error after hiding during a retry's wait", async () => {
    const views: TranscriptionView[] = [];
    const mint = unreachableOnce();
    const controller = createTranscriptionController(
      () => ({ getSession: mint.getSession, retryDelaysMs: [60_000] }),
      view => views.push(view),
    );
    const started = controller.start();
    while (views.at(-1)?.state !== "retrying") await settle();
    fakeDocument.hide();
    await Promise.race([started, new Promise(r => setTimeout(r, 200))]);

    expect(FakeSocket.instances).toEqual([]);
    expect(views.map(view => view.state)).not.toContain("listening");
    expect(views.at(-1)).toMatchObject({ state: "idle", error: null });
    controller.dispose();
  });
});

describe("a microphone that fails to start with AbortError", () => {
  test("still shows its error instead of going quietly back to idle", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new DOMException("Starting audio failed", "AbortError");
          },
        },
      },
    });
    const views: TranscriptionView[] = [];
    const controller = createTranscriptionController(
      () => ({ getSession: session }),
      view => views.push(view),
    );

    await controller.start();

    expect(views.at(-1)).toMatchObject({
      state: "ended",
      error: "Starting audio failed",
    });
    controller.dispose();
  });
});
