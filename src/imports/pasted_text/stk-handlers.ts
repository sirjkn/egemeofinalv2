/**
 * Internal Daraja mutations and queries (V8 runtime - no "use node")
 */
import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.d.ts";

// ── Public query for frontend polling ────────────────────────────────────────

export const getStkRequestPublic = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id as Id<"stkRequests">);
  },
});

// ── Internal queries ──────────────────────────────────────────────────────────

export const getStkRequest = internalQuery({
  args: { id: v.id("stkRequests") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getStkRequestByCheckoutId = internalQuery({
  args: { checkoutRequestId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("stkRequests")
      .withIndex("by_checkoutRequestId", (q) => q.eq("checkoutRequestId", args.checkoutRequestId))
      .first();
  },
});

// ── Internal mutations ────────────────────────────────────────────────────────

export const createStkRequest = internalMutation({
  args: {
    checkoutRequestId: v.string(),
    merchantRequestId: v.string(),
    memberId: v.string(),
    memberNumber: v.string(),
    memberName: v.string(),
    contributionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    plotId: v.optional(v.string()),
    plotNumber: v.optional(v.string()),
    plotProjectId: v.optional(v.string()),
    plotProjectName: v.optional(v.string()),
    clientId: v.optional(v.string()),
    clientName: v.optional(v.string()),
    shareholderId: v.optional(v.string()),
    shareholderName: v.optional(v.string()),
    memberType: v.optional(v.union(v.literal("client"), v.literal("shareholder"))),
    kind: v.union(v.literal("monthly"), v.literal("project"), v.literal("project_instalment"), v.literal("project_contribution"), v.literal("plot_payment")),
    label: v.string(),
    amount: v.number(),
    phone: v.string(),
    penaltyPaid: v.optional(v.boolean()),
    penaltyAmount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<string> => {
    const id = await ctx.db.insert("stkRequests", {
      ...args,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

export const resolveStkRequest = internalMutation({
  args: {
    id: v.id("stkRequests"),
    status: v.union(v.literal("success"), v.literal("failed")),
    resultCode: v.optional(v.string()),
    resultDesc: v.optional(v.string()),
    mpesaReceiptNumber: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const req = await ctx.db.get(args.id);
    if (!req || req.status !== "pending") return;

    await ctx.db.patch(args.id, {
      status: args.status,
      resultCode: args.resultCode,
      resultDesc: args.resultDesc,
      mpesaReceiptNumber: args.mpesaReceiptNumber,
    });

    if (args.status !== "success") return;

    // Apply payment to the appropriate record
    const today = new Date().toISOString().split("T")[0];
    const txnRef = args.mpesaReceiptNumber ?? req.checkoutRequestId;
    const noteStr = `M-Pesa STK ref:${txnRef}`;

    if (req.kind === "monthly" && req.contributionId) {
      const existing = await ctx.db.get(req.contributionId as Id<"monthlyContributions">);
      if (existing) {
        const newPaid = existing.amountPaid + req.amount;
        await ctx.db.patch(existing._id, {
          amountPaid: newPaid,
          paidDate: today,
          penaltyPaid: req.penaltyPaid ?? existing.penaltyPaid,
          status: newPaid >= existing.amountDue ? "paid" : "pending",
          notes: [existing.notes, noteStr].filter(Boolean).join("; "),
          paymentMethod: "mpesa_prompt",
          transactionCode: txnRef,
        });
      }
    }

    if (req.kind === "project_instalment" && req.contributionId) {
      const instalment = await ctx.db.get(req.contributionId as Id<"projectInstalments">);
      if (instalment) {
        await ctx.db.patch(instalment._id, {
          amountPaid: instalment.amountPaid + req.amount,
          paidDate: today,
          status: "paid",
          paymentMethod: "mpesa_prompt",
          transactionCode: txnRef,
        });
      }
    }

    if (req.kind === "project_contribution" && req.projectId) {
      await ctx.db.insert("projectFunding", {
        projectId: req.projectId as Id<"projects">,
        contributorId: req.memberId,
        contributorName: req.memberName,
        memberNumber: req.memberNumber,
        amount: req.amount,
        date: today,
        notes: noteStr,
        type: "monthly",
        paymentMethod: "mpesa_prompt",
        transactionCode: txnRef,
      });
    }

    if (req.kind === "plot_payment" && req.plotId) {
      await ctx.db.insert("plotPayments", {
        plotId: req.plotId,
        plotNumber: req.plotNumber ?? "",
        projectId: req.plotProjectId ?? "",
        projectName: req.plotProjectName ?? "",
        clientId: req.clientId,
        clientName: req.clientName,
        shareholderId: req.shareholderId,
        shareholderName: req.shareholderName,
        memberType: req.memberType ?? "client",
        date: today,
        amount: req.amount,
        paymentMethod: "mpesa_prompt",
        transactionCode: txnRef,
        notes: noteStr,
        isUploaded: false,
      });
    }

    // Notification
    await ctx.db.insert("notifications", {
      recipientId: req.memberNumber,
      recipientRole: "shareholder",
      type: "payment_approved",
      title: "M-Pesa Payment Confirmed",
      message: `Your M-Pesa payment of KES ${req.amount.toLocaleString()} for ${req.label} has been confirmed. Receipt: ${txnRef}`,
      read: false,
      createdAt: new Date().toISOString(),
    });
  },
});
