import { DomainError } from "../domain/errors.ts";
import type { ProjectContextRepository, RequestBudget } from "../domain/project-context.ts";

export async function validateProjectScope(repository: Pick<ProjectContextRepository, "getProject" | "getSubproject">,
  input: { readonly projectId: string; readonly subprojectId?: string | undefined }, budget: RequestBudget) {
  const project = await budget.run(() => repository.getProject(input.projectId, budget));
  if (input.subprojectId) {
    let selected;
    try { selected = await budget.run(() => repository.getSubproject(input.subprojectId!, budget)); }
    catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") throw new DomainError("INVALID_RELATION"); throw error; }
    if (!selected.projectIds.includes(input.projectId)) throw new DomainError("INVALID_RELATION");
  }
  return project;
}
