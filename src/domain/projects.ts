import type { PrimaryStack, ProjectStatus } from "./schema-map.ts";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly description?: string;
  readonly repositoryUrl?: string;
  readonly status?: ProjectStatus;
  readonly primaryStack: readonly PrimaryStack[];
}

export interface ListProjectsInput {
  readonly nameContains?: string;
  readonly status?: ProjectStatus;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ProjectPage {
  readonly projects: readonly Project[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface ProjectRepository {
  list(input: Omit<ListProjectsInput, "nameContains">): Promise<ProjectPage>;
}

export interface ProjectListingService {
  list(input?: unknown): Promise<ProjectPage>;
}
