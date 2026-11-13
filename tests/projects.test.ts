import { describe, expect, it, vi } from "vitest";
import { createProjectListingService } from "../src/services/projects.ts";
import { DomainError, mapError } from "../src/domain/errors.ts";
import { inMemoryProjects, project } from "./fixtures/projects.ts";

describe("project listing service", () => {
  it("defaults to 50 and forwards only validated fields", async () => {
    const list = vi.fn(inMemoryProjects().list);
    await createProjectListingService({ list }).list();
    expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
  });
  it.each([1, 100])("accepts boundary limit %s", async (limit) => {
    expect((await createProjectListingService(inMemoryProjects()).list({ limit })).projects).toEqual([project]);
  });
  it.each([0, 101, -1, 1.5, "10", null, NaN, Infinity])("rejects invalid limit %s without querying", async (limit) => {
    const list = vi.fn(inMemoryProjects().list);
    await expect(createProjectListingService({ list }).list({ limit })).rejects.toMatchObject({ code: "VALIDATION_ERROR", validation: [{ field: "limit" }] });
    expect(list).not.toHaveBeenCalled();
  });
  it("filters names case-insensitively, trims search and applies exact status", async () => {
    const service = createProjectListingService(inMemoryProjects([project, { ...project, name: "Memory", status: "Paused" }]));
    expect((await service.list({ nameContains: "  DEVM  ", status: "Active" })).projects).toEqual([project]);
    expect((await service.list({ status: "Paused" })).projects).toHaveLength(1);
    expect((await service.list({ nameContains: "absent" })).projects).toEqual([]);
  });
  it.each(["active", "Unknown", " Active", ""])('rejects unknown status "%s" with exact allowed values', async (status) => {
    const service = createProjectListingService(inMemoryProjects());
    try {
      await service.list({ status });
      expect.fail("Expected validation failure");
    } catch (error) {
      expect(mapError(error, "correlation")).toMatchObject({ code: "VALIDATION_ERROR", validation: [{ field: "status", allowedValues: ["Active", "Paused", "Archived"] }] });
    }
  });
  it.each([{ nameContains: " " }, { nameContains: "x".repeat(201) }, { cursor: "" }, { cursor: "\n" }, { cursor: "x".repeat(2049) }, { unknown: true }, [], null])("rejects malformed input %j", async (input) => {
    await expect(createProjectListingService(inMemoryProjects()).list(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("preserves sparse page cursors without omitting later matches", async () => {
    const service = createProjectListingService(inMemoryProjects([project, { ...project, name: "Other" }, { ...project, id: "10000000-0000-4000-8000-000000000003", name: "devmemory two" }]));
    const first = await service.list({ nameContains: "devmemory", limit: 1 });
    expect(first).toMatchObject({ projects: [project], hasMore: true, nextCursor: "fixture:1" });
    const second = await service.list({ nameContains: "devmemory", limit: 1, cursor: first.nextCursor });
    expect(second).toEqual({ projects: [], hasMore: true, nextCursor: "fixture:2" });
    const third = await service.list({ nameContains: "devmemory", limit: 1, cursor: second.nextCursor });
    expect(third.projects[0]?.name).toBe("devmemory two");
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
  });
  it("returns a stable empty page", async () => {
    expect(await createProjectListingService(inMemoryProjects([])).list()).toEqual({ projects: [], hasMore: false, nextCursor: null });
  });
  it("preserves repository domain failures", async () => {
    await expect(createProjectListingService({ list: async () => { throw new DomainError("RATE_LIMITED"); } }).list()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
