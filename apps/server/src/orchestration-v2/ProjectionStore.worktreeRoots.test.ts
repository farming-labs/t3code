import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

it.effect.each([
  {
    name: "sqlite",
    layer: ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  },
  { name: "memory", layer: ProjectionStore.layerMemory },
])("$name: startup reads distinct live worktree roots, including archived threads", ({ layer }) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const providerInstanceId = ProviderInstanceId.make("codex");
    for (const [suffix, worktreePath, archived, deleted, project] of [
      ["main", null, false, false, "one"],
      ["active", "/views/shared", false, false, "one"],
      ["duplicate", "/views/shared", false, false, "one"],
      ["archived", "/views/archived", true, false, "one"],
      ["deleted", "/views/deleted", false, true, "one"],
      ["other-project", "/views/shared", false, false, "two"],
    ] as const) {
      const threadId = ThreadId.make(`thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:${suffix}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make(project),
          title: suffix,
          createdBy: "user",
          creationSource: "web",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: archived ? now : null,
          deletedAt: deleted ? now : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
        },
      });
    }
    const roots = yield* store.getWorktreeRoots();
    assert.deepEqual(
      roots.toSorted((a, b) =>
        `${a.projectId}:${a.worktreePath}`.localeCompare(`${b.projectId}:${b.worktreePath}`),
      ),
      [
        { projectId: "one", worktreePath: "/views/archived" },
        { projectId: "one", worktreePath: "/views/shared" },
        { projectId: "two", worktreePath: "/views/shared" },
      ],
    );
  }).pipe(Effect.provide(layer)),
);
