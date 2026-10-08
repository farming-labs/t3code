// @effect-diagnostics nodeBuiltinImport:off -- createRequire loads the disk-backed native package in Node SEA builds.
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { GitCommandFailureReason } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../processRunner.ts";

// The native package must remain on disk, including in desktop/SEA bundles.
const requireRiftri = NodeModule.createRequire(import.meta.url);

const Operation = Schema.Literals([
  "configuration",
  "resolve-reference",
  "add",
  "owner",
  "inspect",
  "remove",
  "prune",
  "repair",
]);
const Reason = Schema.Literals([
  "invalid-configuration",
  "unavailable",
  "failed",
  "invalid-output",
  "repair-required",
  "hook-failed",
  "unsupported-reference",
  "branch-already-exists",
  "branch-checked-out",
  "destination-exists",
]);

class RiftriWorktreeError extends Schema.TaggedError<RiftriWorktreeError>()("RiftriWorktreeError", {
  operation: Operation,
  reason: Reason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.gitErrorFields.detail;
  }

  get gitErrorFields(): { detail: string; reason?: GitCommandFailureReason } {
    switch (this.reason) {
      case "invalid-configuration":
        return { detail: "T3CODE_WORKTREE_STORAGE must be auto, git, or riftri." };
      case "unavailable":
        return {
          detail:
            "Riftri is unavailable. Reinstall the server with its native optional dependencies.",
        };
      case "hook-failed":
        return {
          detail:
            "The checkout hook failed. Riftri kept the created worktree; inspect it before retrying.",
        };
      case "unsupported-reference":
        return {
          detail:
            "Riftri requires a local branch or a resolvable commit. Select an explicit base reference, or use auto storage for Git's remote-branch guessing.",
        };
      case "repair-required":
        return {
          detail: "Riftri state needs attention. Inspect it with riftri status before retrying.",
        };
      case "invalid-output":
        return {
          detail: "Riftri returned an invalid report. No ordinary Git fallback was attempted.",
        };
      case "branch-already-exists":
        return {
          detail: "That branch already exists. Choose another name or use the existing branch.",
          reason: "branch_already_exists",
        };
      case "branch-checked-out":
        return {
          detail:
            "That branch is already checked out in a registered worktree. Use that worktree or choose another branch.",
          reason: "branch_checked_out_in_worktree",
        };
      case "destination-exists":
        return {
          detail:
            "The worktree destination is occupied. Choose another location; existing files were preserved.",
          reason: "path_already_exists",
        };
      case "failed":
        return {
          detail: `Riftri ${this.operation} failed. Inspect riftri status before retrying.`,
        };
    }
  }
}

const AddReport = Schema.Struct({
  schema_version: Schema.Literal(1),
  destination: Schema.String,
  backend: Schema.Literals(["apfs-clone", "reflink", "overlay-fs", "refs-block-clone"]),
  reused_base: Schema.Boolean,
  post_checkout: Schema.NullOr(Schema.Struct({ exit_code: Schema.NullOr(Schema.Number) })),
});
const PreflightRefusal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  outcome: Schema.Literal("failed"),
  operation: Schema.Literal("worktree-add"),
  category: Schema.Literal("policy"),
  code: Schema.Literals([
    "unsupported-checkout",
    "branch-already-exists",
    "branch-checked-out",
    "destination-exists",
  ]),
  cleanup: Schema.Literal("not-needed"),
  recovery: Schema.Literal("not-required"),
});
const Owner = Schema.Struct({
  schema_version: Schema.Literal(1),
  state_directory: Schema.NullOr(Schema.String),
  state_directory_native_hex: Schema.NullOr(Schema.String),
  native_path_encoding: Schema.Literals(["unix-bytes-hex", "windows-utf16le-hex"]),
});
const RepairReport = Schema.Struct({
  schema_version: Schema.Literal(1),
  errors: Schema.Array(Schema.Unknown),
});
const InspectionView = Schema.Struct({
  path: Schema.String,
  path_native_hex: Schema.String,
  state_directory: Schema.NullOr(Schema.String),
  state_directory_native_hex: Schema.NullOr(Schema.String),
  backend: Schema.NullOr(
    Schema.Literals(["apfs-clone", "reflink", "overlay-fs", "refs-block-clone"]),
  ),
  mount_status: Schema.NullOr(
    Schema.Literals([
      "active",
      "recovery-required",
      "different-namespace",
      "foreign",
      "unavailable",
    ]),
  ),
});
const Inspection = Schema.Struct({
  schema_version: Schema.Literal(1),
  native_path_encoding: Schema.Literals(["unix-bytes-hex", "windows-utf16le-hex"]),
  worktrees: Schema.Array(InspectionView),
});

const decodeAddReport = Schema.decodeUnknownEffect(Schema.fromJsonString(AddReport));
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Owner));
const decodeRepairReport = Schema.decodeUnknownEffect(Schema.fromJsonString(RepairReport));
const decodeInspection = Schema.decodeUnknownEffect(Schema.fromJsonString(Inspection));
const decodeRefusal = Schema.decodeUnknownResult(Schema.fromJsonString(PreflightRefusal));
const tryDecodeAddReport = Schema.decodeUnknownResult(Schema.fromJsonString(AddReport));
const decodeStorageMode = Schema.decodeUnknownEffect(Schema.Literals(["auto", "git", "riftri"]));

// This is the storage implementation of GitVcsDriver, not another workspace
// authority. Git still owns refs and every ordinary read/write operation.
export const make = Effect.fn("RiftriWorktrees.make")(function* (
  selectedMode?: "auto" | "git" | "riftri",
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;

  const run = Effect.fn("RiftriWorktrees.run")(function* (
    operation: typeof Operation.Type,
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const executable = yield* Effect.try({
      try: () =>
        environment.RIFTRI_BINARY ??
        (requireRiftri("riftri") as { resolveBinary: () => string }).resolveBinary(),
      catch: (cause) => new RiftriWorktreeError({ operation, reason: "unavailable", cause }),
    });
    const boundary = args.indexOf("--");
    const flags = ["--json", "--json-errors"];
    const argv =
      boundary < 0
        ? [...args, ...flags]
        : [...args.slice(0, boundary), ...flags, ...args.slice(boundary)];
    const output = yield* runner
      .run({
        command: executable,
        args: argv,
        cwd,
        env: { ...environment, GIT_OPTIONAL_LOCKS: "0" },
        timeout: "5 minutes",
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError((cause) => new RiftriWorktreeError({ operation, reason: "failed", cause })),
      );
    if (
      output.stdoutTruncated ||
      output.stderrTruncated ||
      output.stdoutInvalidUtf8 ||
      output.stderrInvalidUtf8
    ) {
      return yield* new RiftriWorktreeError({ operation, reason: "invalid-output", cause: output });
    }
    return output;
  });

  const decode = <A, E>(
    decoder: (input: unknown) => Effect.Effect<A, E>,
    operation: typeof Operation.Type,
    output: ProcessRunner.ProcessRunOutput,
  ) =>
    decoder(output.stdout).pipe(
      Effect.mapError(
        (cause) => new RiftriWorktreeError({ operation, reason: "invalid-output", cause }),
      ),
    );

  const requireSuccess = (
    operation: typeof Operation.Type,
    output: ProcessRunner.ProcessRunOutput,
  ) =>
    output.code === 0 && !output.timedOut
      ? Effect.void
      : Effect.fail(new RiftriWorktreeError({ operation, reason: "failed", cause: output }));

  const repair = Effect.fn("RiftriWorktrees.repair")(function* (
    cwd: string,
    stateDirectory: string,
  ) {
    const output = yield* run("repair", cwd, ["repair", `--state-dir=${stateDirectory}`]);
    yield* requireSuccess("repair", output);
    const report = yield* decode(decodeRepairReport, "repair", output);
    if (report.errors.length > 0) {
      return yield* new RiftriWorktreeError({
        operation: "repair",
        reason: "repair-required",
        cause: report,
      });
    }
  });

  const resolveReference = Effect.fn("RiftriWorktrees.resolveReference")(function* (
    cwd: string,
    revision: string,
  ) {
    const probe = Effect.fn("RiftriWorktrees.probeReference")(function* (
      args: ReadonlyArray<string>,
      invalidBranchAllowed = false,
    ) {
      const output = yield* runner
        .run({
          command: "git",
          args,
          cwd,
          env: { ...environment, RIFTRI_BYPASS: "1", GIT_OPTIONAL_LOCKS: "0" },
          timeout: "5 seconds",
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RiftriWorktreeError({ operation: "resolve-reference", reason: "failed", cause }),
          ),
        );
      if (
        output.timedOut ||
        (output.code !== 0 && output.code !== 1 && !(invalidBranchAllowed && output.code === 128))
      ) {
        return yield* new RiftriWorktreeError({
          operation: "resolve-reference",
          reason: "failed",
          cause: output,
        });
      }
      if (
        output.stdoutTruncated ||
        output.stderrTruncated ||
        output.stdoutInvalidUtf8 ||
        output.stderrInvalidUtf8
      ) {
        return yield* new RiftriWorktreeError({
          operation: "resolve-reference",
          reason: "invalid-output",
          cause: output,
        });
      }
      return output;
    });
    // Git prefers an existing short local branch, even when a tag shares its
    // name. HEAD, tags, hashes and fully-qualified refs are detached instead.
    if ((yield* probe(["show-ref", "--verify", "--quiet", `refs/heads/${revision}`])).code === 0) {
      return { mode: "branch" as const, revision };
    }
    // Let Git expand previous-checkout expressions such as @{-1}; resolving
    // only their commit would silently detach a branch that Git checks out.
    const expanded = yield* probe(["check-ref-format", "--branch", revision], true);
    const branch = expanded.stdout.trim();
    if (
      expanded.code === 0 &&
      branch !== revision &&
      (yield* probe(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0
    ) {
      return { mode: "branch" as const, revision: branch };
    }
    if (
      (yield* probe([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ])).code === 0
    ) {
      return { mode: "detached" as const, revision };
    }
    // An unresolved name may trigger Git's remote-branch guessing, including
    // checkout.defaultRemote and tracking configuration. Leave that to Git.
    return { mode: "git" as const, revision };
  });

  const create = Effect.fn("RiftriWorktrees.create")(function* (input: {
    readonly cwd: string;
    readonly destination: string;
    readonly revision: string;
    readonly branch?: string;
  }) {
    const mode = yield* decodeStorageMode(
      selectedMode ?? environment.T3CODE_WORKTREE_STORAGE ?? "auto",
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RiftriWorktreeError({
            operation: "configuration",
            reason: "invalid-configuration",
            cause,
          }),
      ),
    );
    if (mode === "git") return null;
    const head = input.branch
      ? { mode: "branch", revision: input.revision }
      : yield* resolveReference(input.cwd, input.revision);
    if (head.mode === "git") {
      if (mode === "riftri") {
        return yield* new RiftriWorktreeError({
          operation: "add",
          reason: "unsupported-reference",
        });
      }
      // This is a pre-mutation delegation, not a retry after native failure.
      // Incomplete journals or a managed destination must still block it.
      if ((yield* findOwner(input.cwd, input.destination)) !== null) {
        return yield* new RiftriWorktreeError({ operation: "add", reason: "repair-required" });
      }
      yield* Effect.logWarning(
        "Worktree uses ordinary Git: remote-branch guessing requires Git's reference handling.",
      );
      return null;
    }
    // Add validates the exact requested tree and destination itself. A separate
    // doctor would duplicate that work and inspect the caller's HEAD instead.
    // Place immutable data beside the destination so cross-volume repositories
    // can still clone. The native journal registers this location with Git.
    const stateDirectory = path.join(path.dirname(input.destination), ".t3-riftri");
    // Native add rejects pending recovery under its own locks. Do not run a
    // state-wide repair on every cached add or mutate other views implicitly.
    const output = yield* run("add", input.cwd, [
      "worktree",
      "add",
      `--state-dir=${stateDirectory}`,
      ...(input.branch ? [`--branch=${input.branch}`] : []),
      ...(head.mode === "detached" ? ["--detach"] : []),
      "--",
      input.destination,
      head.revision,
    ]).pipe(
      Effect.onInterrupt(() =>
        repair(input.cwd, stateDirectory).pipe(
          Effect.catchTags({
            RiftriWorktreeError: () =>
              Effect.logWarning(
                "Interrupted Riftri worktree creation needs inspection with riftri status.",
              ),
          }),
          Effect.andThen(
            Effect.logWarning(
              "Creation was interrupted. Inspect riftri worktree list before retrying; a completed worktree may have been retained.",
            ),
          ),
        ),
      ),
    );
    if (output.code !== 0) {
      const receipt = decodeRefusal(output.stderr.trim().split("\n").at(-1));
      if (
        !output.timedOut &&
        output.code === 3 &&
        output.stdout.trim() === "" &&
        Result.isSuccess(receipt)
      ) {
        if (receipt.success.code !== "unsupported-checkout") {
          return yield* new RiftriWorktreeError({
            operation: "add",
            reason: receipt.success.code,
            cause: output,
          });
        }
        if (mode === "auto") {
          yield* Effect.logWarning(
            "Worktree uses ordinary Git: this checkout is unsupported by Riftri.",
          );
          return null;
        }
      }
      const report = tryDecodeAddReport(output.stdout);
      if (
        Result.isSuccess(report) &&
        report.success.post_checkout !== null &&
        report.success.post_checkout.exit_code !== 0
      ) {
        return yield* new RiftriWorktreeError({
          operation: "add",
          reason: "hook-failed",
          cause: output,
        });
      }
      yield* requireSuccess("add", output);
    }
    yield* requireSuccess("add", output);
    const report = yield* decode(decodeAddReport, "add", output);
    yield* Effect.logInfo("Created a Riftri worktree.", {
      backend: report.backend,
      reusedBase: report.reused_base,
    });
    return report;
  });

  const findOwner = Effect.fn("RiftriWorktrees.findOwner")(function* (
    cwd: string,
    destination: string,
  ) {
    // Ownership must still be checked in git mode and after a server restart.
    // Never infer "unmanaged" from a failed discovery or a missing directory.
    const output = yield* run("owner", cwd, ["worktree", "owner", "--", destination]);
    yield* requireSuccess("owner", output);
    const owner = yield* decode(decodeOwner, "owner", output);
    if (owner.state_directory === null && owner.state_directory_native_hex === null) return null;
    // The CLI's display paths can be lossy. Do not route a mutation to a
    // different directory when Node cannot represent the native path exactly.
    if (
      owner.state_directory === null ||
      owner.state_directory_native_hex !==
        Buffer.from(
          owner.state_directory,
          owner.native_path_encoding === "unix-bytes-hex" ? "utf8" : "utf16le",
        ).toString("hex")
    ) {
      return yield* new RiftriWorktreeError({
        operation: "owner",
        reason: "invalid-output",
        cause: owner,
      });
    }
    return owner.state_directory;
  });

  const remove = Effect.fn("RiftriWorktrees.remove")(function* (input: {
    readonly cwd: string;
    readonly destination: string;
    readonly force?: boolean;
  }) {
    const stateDirectory = yield* findOwner(input.cwd, input.destination);
    if (stateDirectory === null) return false;
    const removed = yield* run("remove", input.cwd, [
      "worktree",
      "remove",
      `--state-dir=${stateDirectory}`,
      ...(input.force ? ["--force", "--yes"] : []),
      "--",
      input.destination,
    ]);
    yield* requireSuccess("remove", removed);
    return true;
  });

  const prune = Effect.fn("RiftriWorktrees.prune")(function* (cwd: string) {
    // Native prune validates every registered state before touching Git's
    // registrations, including incomplete operations in another state folder.
    const output = yield* run("prune", cwd, ["worktree", "prune"]);
    yield* requireSuccess("prune", output);
  });

  const inspect = Effect.fn("RiftriWorktrees.inspect")(function* (
    cwd: string,
    destinations: ReadonlyArray<string>,
  ) {
    const views: Array<typeof InspectionView.Type> = [];
    // Keep argv bounded on Windows as well as Unix. Batched metadata reads
    // avoid one process and one state discovery pass per persisted thread.
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;
    for (const destination of destinations) {
      const size = Buffer.byteLength(destination, "utf8") * 2 + 4;
      if (batch.length > 0 && bytes + size > 8192) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(destination);
      bytes += size;
    }
    if (batch.length > 0) batches.push(batch);
    for (const paths of batches) {
      const output = yield* run("inspect", cwd, ["worktree", "inspect", "--", ...paths]);
      yield* requireSuccess("inspect", output);
      const report = yield* decode(decodeInspection, "inspect", output);
      const encoding = report.native_path_encoding === "unix-bytes-hex" ? "utf8" : "utf16le";
      if (
        report.worktrees.length !== paths.length ||
        report.worktrees.some((view, index) => {
          if (
            view.path !== paths[index] ||
            view.path_native_hex !== Buffer.from(view.path, encoding).toString("hex")
          )
            return true;
          if (view.state_directory === null) {
            return (
              view.state_directory_native_hex !== null ||
              view.backend !== null ||
              view.mount_status !== null
            );
          }
          return (
            !path.isAbsolute(view.state_directory) ||
            view.state_directory_native_hex !==
              Buffer.from(view.state_directory, encoding).toString("hex") ||
            view.backend === null ||
            (view.backend === "overlay-fs"
              ? view.mount_status === null
              : view.mount_status !== null)
          );
        })
      ) {
        return yield* new RiftriWorktreeError({
          operation: "inspect",
          reason: "invalid-output",
          cause: report,
        });
      }
      views.push(...report.worktrees);
    }
    return views;
  });

  const restore = Effect.fn("RiftriWorktrees.restore")(function* (input: {
    readonly cwd: string;
    readonly destinations: ReadonlyArray<string>;
  }) {
    const destinations = [...new Set(input.destinations)];
    const views = yield* inspect(input.cwd, destinations);
    const states = new Set<string>();
    for (const view of views) {
      if (view.mount_status === null || view.mount_status === "active") continue;
      if (view.mount_status !== "recovery-required" || view.state_directory === null) {
        return yield* new RiftriWorktreeError({
          operation: "inspect",
          reason: "repair-required",
          cause: view,
        });
      }
      states.add(view.state_directory);
    }
    if (states.size === 0) return;
    for (const state of states) yield* repair(input.cwd, state);
    // Repair skips busy journals. Success alone must not let a provider write
    // into the empty directory hidden beneath an absent OverlayFS mount.
    const restored = yield* inspect(input.cwd, destinations);
    for (const [index, before] of views.entries()) {
      if (before.backend !== "overlay-fs") continue;
      const after = restored[index]!;
      if (
        after.state_directory !== before.state_directory ||
        after.backend !== before.backend ||
        after.mount_status !== "active"
      ) {
        return yield* new RiftriWorktreeError({
          operation: "inspect",
          reason: "repair-required",
          cause: after,
        });
      }
    }
  });

  return { create, remove, prune, restore };
});
