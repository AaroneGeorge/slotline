/**
 * What a planner (LLM or rules) returns. Deliberately flat and nullable so it
 * works with strict structured-output modes. It carries no feasibility and no
 * amounts: validatePlan computes those in code.
 */
import { z } from "zod";

export const ACTION_TYPES = ["move", "promote", "void", "capture", "refund", "send_invoice", "send_reminder", "message", "flag_dispute"] as const;

export const rawActionSchema = z.object({
  type: z.enum(ACTION_TYPES).describe("Action type"),
  bookingId: z.string().describe("Id of the booking this action applies to (from the context)"),
  startAt: z.string().nullable().describe("move/promote only: new start time, ISO-8601 UTC"),
  resourceId: z.string().nullable().describe("move/promote only: van id, e.g. van-1"),
  channel: z.enum(["email", "sms"]).nullable().describe("message only"),
  subject: z.string().nullable().describe("message only: email subject"),
  body: z.string().nullable().describe("message only: the text to send the customer"),
});

export const rawOptionSchema = z.object({
  title: z.string().describe("Short imperative title, e.g. 'Give Marcus's 10:00 slot to Lee'"),
  rationale: z.string().describe("One or two sentences: why this option, trade-offs"),
  actions: z.array(rawActionSchema),
});

export const rawPlanSchema = z.object({
  summary: z.string().describe("One sentence describing what happened and what you recommend"),
  options: z.array(rawOptionSchema).describe("1-3 options, best first"),
  draftMessages: z.array(
    z.object({
      bookingId: z.string(),
      channel: z.enum(["email", "sms"]),
      subject: z.string().nullable(),
      body: z.string(),
    }),
  ),
});

export type RawAction = z.infer<typeof rawActionSchema>;
export type RawOption = z.infer<typeof rawOptionSchema>;
export type RawPlan = z.infer<typeof rawPlanSchema>;

/** Convenience for the rules planner. */
export function rawAction(type: RawAction["type"], bookingId: string, extra: Partial<Omit<RawAction, "type" | "bookingId">> = {}): RawAction {
  return { type, bookingId, startAt: null, resourceId: null, channel: null, subject: null, body: null, ...extra };
}
