# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

## Authentication is enforced in functions

Frontend route guards and Viktor's edge access gate do not protect the public
Convex API. In an authenticated Space, define app-facing functions with
`authenticatedQuery`, `authenticatedMutation`, and `authenticatedAction` from
`./functions`. They reject anonymous calls and expose the verified user ID as
`ctx.userId`.

Use the raw `query`, `mutation`, or `action` builders only for a deliberately
public endpoint. Use `internalQuery`, `internalMutation`, or `internalAction`
for functions that should only be called by other Convex functions.

An authenticated query looks like:

```ts
// convex/myFunctions.ts
import { v } from "convex/values";
import { authenticatedQuery } from "./functions";

export const currentUserName = authenticatedQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async ctx => {
    const user = await ctx.db.get(ctx.userId);
    return user?.name ?? null;
  },
});
```

Using this query function in a React component looks like:

```ts
const name = useQuery(api.myFunctions.currentUserName);
```

An authenticated mutation looks like:

```ts
// convex/myFunctions.ts
import { v } from "convex/values";
import { authenticatedMutation } from "./functions";

export const updateMyName = authenticatedMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    await ctx.db.patch(ctx.userId, { name });
    return null;
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.updateMyName);
function handleButtonPress() {
  void mutation({ name: "Ada" });
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.
