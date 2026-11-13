import * as z from "zod";
import { RequestValidationError } from "../domain/errors.ts";
import type { ProjectListingService, ProjectRepository } from "../domain/projects.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";

export const listProjectsInputSchema = z.strictObject({
  nameContains: z.string().trim().min(1).max(200).optional(),
  status: z.enum(NOTION_SCHEMA.projects.status.options).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  // Hex escapes preserve the control-character exclusion and are accepted by
  // Antigravity 1.5.3's Go regex validator for advertised JSON schemas.
  cursor: z.string().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
});

export function createProjectListingService(repository: ProjectRepository): ProjectListingService {
  return Object.freeze({
    async list(input: unknown = {}) {
      const parsed = listProjectsInputSchema.safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => {
          const field = String(issue.path[0] ?? "input");
          return ["nameContains", "status", "limit", "cursor"].includes(field) ? field : "input";
        }))];
        throw new RequestValidationError(fields.map((field) => ({
          field,
          ...(field === "status" ? { allowedValues: NOTION_SCHEMA.projects.status.options } : {}),
        })));
      }
      // Status is filtered upstream. Scan exactly one bounded raw page for name
      // matching; retain its cursor even if this page has zero matching names.
      // Clients must follow hasMore, not the number of returned projects.
      const value = parsed.data;
      const page = await repository.list({
        limit: value.limit,
        ...(value.status !== undefined ? { status: value.status } : {}),
        ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
      });
      const needle = value.nameContains?.toLowerCase();
      return Object.freeze({ ...page,
        projects: Object.freeze(needle === undefined ? [...page.projects] : page.projects.filter((project) => project.name.toLowerCase().includes(needle))),
      });
    },
  });
}
