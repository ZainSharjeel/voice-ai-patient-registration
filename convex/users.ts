import { authenticatedMutation } from "./functions";

export const deleteAccount = authenticatedMutation({
  args: {},
  handler: async ctx => {
    const authAccounts = await ctx.db
      .query("authAccounts")
      .filter(q => q.eq(q.field("userId"), ctx.userId))
      .collect();
    for (const account of authAccounts) {
      await ctx.db.delete(account._id);
    }

    const authSessions = await ctx.db
      .query("authSessions")
      .filter(q => q.eq(q.field("userId"), ctx.userId))
      .collect();
    for (const session of authSessions) {
      await ctx.db.delete(session._id);
    }

    await ctx.db.delete(ctx.userId);

    return { success: true };
  },
});
