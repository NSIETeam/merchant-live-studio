import { z } from "zod";
import type { MemberRole } from "./membership.js";
export const destinationSchema = z.enum([
  "content",
  "studio",
  "copilot",
  "training",
  "rewards",
  "analytics",
]);
export type Destination = z.infer<typeof destinationSchema>;
export const homeModuleSchema = z.enum([
  "shortcuts",
  "rooms",
  ...destinationSchema.options,
]);
export type HomeModule = z.infer<typeof homeModuleSchema>;
export function homeDestinations(role: MemberRole): Destination[] {
  return destinationSchema.options.filter(
    (id) =>
      role === "owner" ||
      (role === "analyst"
        ? id === "analytics"
        : role === "reviewer"
          ? ["content", "studio", "analytics"].includes(id)
          : id !== "rewards"),
  );
}
export const homeLayoutSchema = z
  .object({
    modules: z
      .array(homeModuleSchema)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, "模块不可重复"),
    shortcuts: z
      .array(destinationSchema)
      .max(6)
      .refine((ids) => new Set(ids).size === ids.length, "快捷入口不可重复"),
  })
  .strict();
export type HomeLayout = z.infer<typeof homeLayoutSchema>;
export type HomePreferences = HomeLayout & { version: number };
