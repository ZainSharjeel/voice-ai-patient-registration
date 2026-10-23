import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let accessMode: string | undefined = "public";
let modeReads = 0;
const visited: string[] = [];
let currentUrl = "about:blank";

function fakePage() {
  return {
    on: () => {},
    url: () => currentUrl,
    goto: async (url: string) => {
      visited.push(url);
      currentUrl = url;
    },
    context: () => ({ storageState: async () => {} }),
  };
}

const fakeBrowser = {
  newContext: async () => ({ newPage: async () => fakePage() }),
  close: async () => {},
};

mock.module("playwright", () => ({
  chromium: { launch: async () => fakeBrowser },
}));
mock.module("./space-access-mode", () => ({
  servedAccessMode: () => {
    modeReads++;
    return accessMode;
  },
}));

// A fresh module instance per test: auth.ts reads the mode once per process.
async function freshAuth(label: string) {
  return (await import(`./auth.ts?${label}`)) as typeof import("./auth");
}

const originalFetch = globalThis.fetch;
const fetched: string[] = [];

beforeEach(() => {
  visited.length = 0;
  fetched.length = 0;
  modeReads = 0;
  currentUrl = "about:blank";
  process.env.APP_URL = "http://127.0.0.1:4173";
  for (const name of [
    "VIKTOR_SPACES_API_URL",
    "VIKTOR_SPACES_PROJECT_NAME",
    "VIKTOR_SPACES_PROJECT_SECRET",
    "TOOL_TOKEN",
  ]) {
    delete process.env[name];
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    throw new Error("no network in tests");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.APP_URL;
});

test("a public Space opens the app without signing in", async () => {
  accessMode = "public";
  const { createPageHelper } = await freshAuth("public");
  const helper = await createPageHelper();
  expect(visited).toEqual(["http://127.0.0.1:4173/"]);
  expect(fetched).toEqual([]);
  expect(helper.spaceSessionSid).toBeUndefined();
  await createPageHelper();
  expect(modeReads).toBe(1);
});

test("an authenticated Space still signs in", async () => {
  accessMode = "authenticated";
  const { createPageHelper } = await freshAuth("authenticated");
  await expect(createPageHelper()).rejects.toThrow(
    /Cannot mint a space session/,
  );
  expect(visited[0]).toBe("http://127.0.0.1:4173/login");
});
