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
export const disclosureSchema = z
  .object({
    operator: businessSchema,
    seller: businessSchema,
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
