import { beforeEach, describe, expect, mock, test } from "bun:test";

type FunctionDefinition = {
  handler: (
    ctx: Record<string, unknown>,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

let authenticatedUserId: string | null = null;
const passthroughBuilder = (definition: FunctionDefinition) => definition;

mock.module("../convex/_generated/server", () => ({
  action: passthroughBuilder,
  mutation: passthroughBuilder,
  query: passthroughBuilder,
}));

mock.module("@convex-dev/auth/server", () => ({
  getAuthUserId: async () => authenticatedUserId,
}));

beforeEach(() => {
  authenticatedUserId = null;
});

describe("authenticated Convex function builders", () => {
  test("reject anonymous query, mutation, and action calls", async () => {
    const { authenticatedAction, authenticatedMutation, authenticatedQuery } =
      await import("../convex/functions");

    for (const builder of [
      authenticatedQuery,
      authenticatedMutation,
      authenticatedAction,
    ]) {
      const definition = builder({
        args: {},
        handler: async ctx => ctx.userId,
      }) as unknown as FunctionDefinition;

      await expect(definition.handler({}, {})).rejects.toThrow(
        "Not authenticated",
      );
    }
  });

  test("injects the verified user id into authenticated handlers", async () => {
    authenticatedUserId = "users:test-user";
    const { authenticatedQuery } = await import("../convex/functions");
    const definition = authenticatedQuery({
      args: {},
      handler: async ctx => ctx.userId,
    }) as unknown as FunctionDefinition;

    expect(await definition.handler({}, {})).toBe("users:test-user");
  });

  test("protects built-in account and Viktor tool functions", async () => {
    const [{ deleteAccount }, { generateImage, quickAiSearch }] =
      await Promise.all([
        import("../convex/users"),
        import("../convex/viktorTools"),
      ]);

    for (const definition of [deleteAccount, quickAiSearch, generateImage]) {
      await expect(
        (definition as unknown as FunctionDefinition).handler({}, {}),
      ).rejects.toThrow("Not authenticated");
    }
  });
});
