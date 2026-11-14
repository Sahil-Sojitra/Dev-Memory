import type { KnowledgeEntry, RequestBudget, ContextPage } from "./project-context.ts";

export interface KnowledgeDetail extends KnowledgeEntry {
  readonly title: string;
  readonly created: string;
  readonly projectIds: readonly string[];
  readonly subprojectIds: readonly string[];
  readonly relationsTruncated: boolean;
  readonly relationTruncationReasons: readonly ("request_budget" | "relation_limit")[];
}
// Application-owned block surface; no Notion SDK payloads escape the repository.
export interface BodyBlock {
  readonly id: string;
  readonly type: string;
  readonly hasChildren: boolean;
  readonly text: string;
  readonly markdown: string;
  readonly caption: string;
  readonly url?: string;
  readonly language?: string;
  readonly checked?: boolean;
  readonly cells?: readonly string[];
}
export interface KnowledgeEntryRepository {
  getEntry(pageId: string, budget: RequestBudget): Promise<KnowledgeDetail>;
  listBlocks(blockId: string, cursor: string | undefined, budget: RequestBudget): Promise<ContextPage<BodyBlock>>;
}
export type ContentLimitReason = "request_budget" | "depth_limit" | "block_limit" | "content_limit" | "unsupported_block" | "relation_limit";
export interface KnowledgeBody {
  readonly markdown: string;
  readonly truncated: boolean;
  readonly reasons: readonly ContentLimitReason[];
  readonly blocksRead: number;
  readonly unsupportedBlocks: number;
}
export interface KnowledgeEntryResult {
  readonly entry: KnowledgeDetail;
  readonly content: KnowledgeBody;
  readonly truncated: boolean;
  readonly cacheHit: boolean;
  readonly requestBudget: { readonly maxRequests: number; readonly usedRequests: number; readonly maxDurationMs: number };
}
export interface KnowledgeEntryService { get(input: unknown): Promise<KnowledgeEntryResult> }
