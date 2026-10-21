import { z } from "zod";
export const presenterSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    roleDescription: z.string().trim().min(1).max(400),
    speakingStyle: z.string().trim().min(1).max(1200),
    pace: z.enum(["slow", "balanced", "brisk"]),
    authorizationReference: z.string().trim().min(1).max(500),
    authorizationConfirmed: z.literal(true),
  })
  .strict();
