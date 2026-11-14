import type { Project } from "./projects.ts";
import type { KnowledgeType, KnowledgeVerification, SubprojectType, ProjectStatus, KnowledgeTag } from "./schema-map.ts";

export interface RequestBudget {
  consume(): void;
  assertActive(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  dispose(): void;
  readonly signal: AbortSignal;
  readonly used: number;
  readonly maxRequests: number;
  readonly maxDurationMs: number;
}
export interface ContextInput { readonly projectId: string; readonly subprojectId?: string; readonly recentLimit: number }
export interface Subproject {
  readonly id: string; readonly name: string; readonly url: string;
  readonly description?: string; readonly repositoryPath?: string; readonly type?: SubprojectType; readonly status?: ProjectStatus;
  readonly projectIds: readonly string[];
}
export interface KnowledgeEntry {
  readonly id: string; readonly name: string; readonly url: string; readonly lastUpdated: string;
  readonly type?: KnowledgeType; readonly verification?: KnowledgeVerification;
  readonly context?: string; readonly files?: string; readonly sourceUrl?: string; readonly tags: readonly KnowledgeTag[];
}
export interface KnowledgeClassification { readonly id: string; readonly type?: KnowledgeType; readonly verification?: KnowledgeVerification }
export interface ContextPage<T> { readonly items: readonly T[]; readonly hasMore: boolean; readonly nextCursor: string | null }
export interface KnowledgeQuery {
  readonly projectId: string; readonly subprojectId?: string; readonly limit: number; readonly cursor?: string;
  readonly category?: "setup" | "needsReview";
}
export interface ProjectContextRepository {
  getProject(id: string, budget: RequestBudget): Promise<Project>;
  getSubproject(id: string, budget: RequestBudget): Promise<Subproject>;
  listSubprojects(projectId: string, limit: number, cursor: string | undefined, budget: RequestBudget): Promise<ContextPage<Subproject>>;
  listKnowledge(input: KnowledgeQuery, budget: RequestBudget): Promise<ContextPage<KnowledgeEntry>>;
  scanKnowledge(input: KnowledgeQuery, budget: RequestBudget): Promise<ContextPage<KnowledgeClassification>>;
}
export interface ScanInfo {
  readonly scanned: number; readonly complete: boolean; readonly truncated: boolean;
  readonly reason: "scan_limit" | "request_budget" | "result_limit" | null;
}
export interface ProjectContext {
  readonly project: Project;
  readonly subprojectId?: string;
  readonly subprojects: readonly Subproject[];
  readonly knowledgeCounts: { readonly total: number; readonly byType: Readonly<Record<string, number>>; readonly byVerification: Readonly<Record<string, number>> };
  readonly recentKnowledge: readonly KnowledgeEntry[];
  readonly setupRunbooks: readonly KnowledgeEntry[];
  readonly needsReview: readonly KnowledgeEntry[];
  readonly scan: Readonly<Record<"subprojects" | "knowledgeCounts" | "recentKnowledge" | "setupRunbooks" | "needsReview", ScanInfo>>;
  readonly requestBudget: { readonly maxRequests: number; readonly usedRequests: number; readonly maxDurationMs: number };
}
export interface ProjectContextService { get(input: unknown): Promise<ProjectContext> }
