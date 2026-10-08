import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ProcessRunner from "../processRunner.ts";
import * as RiftriWorktrees from "../vcs/RiftriWorktrees.ts";

export class WorkspaceStorageUnavailableError extends Schema.TaggedError<WorkspaceStorageUnavailableError>()(
  "WorkspaceStorageUnavailableError",
  { workspaceRoot: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Workspace storage is not ready: ${this.workspaceRoot}. Inspect and repair its Riftri state, then retry. Existing files have been preserved.`;
  }
}

export class WorkspaceStorage extends Context.Service<
  WorkspaceStorage,
  {
    readonly restore: (input: {
      readonly cwd: string;
      readonly destinations: ReadonlyArray<string>;
    }) => Effect.Effect<void>;
    readonly ensureReady: (cwd: string) => Effect.Effect<void, WorkspaceStorageUnavailableError>;
  }
>()("t3/workspace/WorkspaceStorage") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storage = yield* RiftriWorktrees.make();
  const locks = yield* KeyedLock.make<string>();
  const blocked = new Map<
    string,
    { readonly cwd: string; readonly aliases: ReadonlyArray<string> }
  >();

  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };

  const canonical = Effect.fnUntraced(function* (candidate: string): Effect.fn.Return<string> {
    const resolved = path.resolve(candidate);
    const result = yield* fileSystem.realPath(resolved).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    // New files have no realpath yet. Resolve their closest existing parent so
    // a symlink to an unavailable worktree cannot bypass the write guard.
    return path.join(yield* canonical(parent), path.basename(resolved));
  });

  const restore: WorkspaceStorage["Service"]["restore"] = (input) =>
    locks.withLock(
      input.cwd,
      Effect.gen(function* () {
        const destinations = [
          ...new Set(input.destinations.map((destination) => path.resolve(destination))),
        ];
        for (const destination of destinations) {
          blocked.set(destination, {
            cwd: input.cwd,
            aliases: [destination, yield* canonical(destination)],
          });
        }
        const batch = yield* storage.restore({ ...input, destinations }).pipe(Effect.result);
        for (const destination of destinations) {
          // The successful path stays batched. Only a failed batch needs to
          // distinguish a broken workspace from its healthy neighbors.
          const result =
            Result.isSuccess(batch) || destinations.length === 1
              ? batch
              : yield* storage
                  .restore({ cwd: input.cwd, destinations: [destination] })
                  .pipe(Effect.result);
          if (Result.isSuccess(result)) {
            blocked.delete(destination);
          } else {
            yield* Effect.logWarning(
              "Workspace storage could not be restored; only this workspace is blocked",
              {
                workspaceRoot: destination,
              },
            );
          }
        }
      }),
    );

  const ensureReady = Effect.fnUntraced(function* (cwd: string) {
    // No filesystem calls or native processes on the normal, healthy path.
    if (blocked.size === 0) return;
    const candidate = path.resolve(cwd);
    const realCandidate = yield* canonical(candidate);
    for (const [destination, entry] of blocked) {
      if (
        !entry.aliases.some((alias) => contains(alias, candidate) || contains(alias, realCandidate))
      )
        continue;
      yield* locks.withLock(
        entry.cwd,
        Effect.gen(function* () {
          if (!blocked.has(destination)) return;
          const result = yield* storage
            .restore({ cwd: entry.cwd, destinations: [destination] })
            .pipe(Effect.result);
          if (Result.isSuccess(result)) {
            blocked.delete(destination);
            return;
          }
          return yield* new WorkspaceStorageUnavailableError({
            workspaceRoot: destination,
            cause: result.failure,
          });
        }),
      );
    }
  });

  return WorkspaceStorage.of({ restore, ensureReady });
});

export const layer = Layer.effect(WorkspaceStorage, make).pipe(Layer.provide(ProcessRunner.layer));
