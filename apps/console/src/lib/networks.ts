import { z } from "zod";

export const networkNodeSchema = z.object({
  id: z.string(), url: z.string(), label: z.string(), platform: z.string(), scan_id: z.string(),
  score: z.number(), level: z.string(), scan_count: z.number(), rule_flagged: z.boolean(), provenance: z.string(),
});
export const networkEdgeSchema = z.object({
  id: z.string(), source: z.string(), target: z.string(), kind: z.enum(["citation", "promo", "referral"]), value: z.string(),
  citations: z.array(z.object({ scan_id: z.string(), account_id: z.string(), source_url: z.string(), quote: z.string(),
    captured_at: z.string().nullable(), provenance: z.string() })),
});
export const networksSchema = z.object({
  mode: z.enum(["live", "demo"]), nodes: z.array(networkNodeSchema), edges: z.array(networkEdgeSchema),
  summary: z.object({ accounts: z.number(), connections: z.number(), connected_accounts: z.number(),
    scans_considered: z.number(), scans_included: z.number(), scan_limit: z.number(), window_full: z.boolean(), edges_truncated: z.boolean() }),
});
export type NetworkNode = z.infer<typeof networkNodeSchema>;
export type NetworkEdge = z.infer<typeof networkEdgeSchema>;
