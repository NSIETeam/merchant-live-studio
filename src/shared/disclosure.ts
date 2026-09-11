import { z } from "zod";
export const businessSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    creditCode: z
      .string()
      .trim()
      .regex(/^[0-9A-Z]{18}$/, "统一社会信用代码须为 18 位大写字母或数字"),
    address: z.string().trim().min(5).max(240),
    contact: z.string().trim().min(5).max(120),
    licenses: z.string().trim().min(2).max(1000),
  })
  .strict();
export function disclosureDeadline(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const utc = Date.parse(value + "T00:00:00Z");
  if (
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== value
  )
    return null;
  return utc - 8 * 3600000 + 86400000;
}
export function disclosureInDate(
  data: { validThrough?: string },
  now = Date.now(),
): boolean {
  const deadline = disclosureDeadline(data.validThrough);
  return deadline !== null && now < deadline;
}
export const disclosureSchema = z
  .object({
    operator: businessSchema,
    seller: businessSchema,
    validThrough: z
      .string()
      .refine(
        (value) => disclosureDeadline(value) !== null,
        "请填写有效的资料复核截止日期",
      ),
    complaintContact: z.string().trim().min(5).max(240),
  })
  .strict();
export type Disclosure = z.infer<typeof disclosureSchema>;
export interface DisclosureVersion {
  version: number;
  data: Disclosure;
  evidenceReference: string;
  authorId: string;
  createdAt: number;
}
export interface DisclosureEvent {
  id: number;
  version: number;
  action: "publish" | "withdraw";
  actorId: string;
  note: string;
  createdAt: number;
}
export interface DisclosureState {
  latest: DisclosureVersion | null;
  publication: DisclosureEvent | null;
  events: DisclosureEvent[];
}
export interface PublicDisclosure {
  version: number;
  publishedAt: number;
  data: Disclosure;
}
