import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as RiftriWorktrees from "./RiftriWorktrees.ts";

const output = (code: number, stdout: unknown, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout: stdout === undefined ? "" : JSON.stringify(stdout),
  stderr,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const inspectionView = (destination: string, mount: string | null = null) => ({
  path: destination,
  path_native_hex: Buffer.from(destination).toString("hex"),
  state_directory: "/storage/state",
  state_directory_native_hex: Buffer.from("/storage/state").toString("hex"),
  backend: mount === null ? "reflink" : "overlay-fs",
  mount_status: mount,
});
const inspection = (views: ReadonlyArray<unknown>) =>
  output(0, { schema_version: 1, native_path_encoding: "unix-bytes-hex", worktrees: views });

it.effect("large restart batches stay bounded and validate every batch before repair", () =>
  Effect.gen(function* () {
    const destinations = Array.from(
      { length: 100 },
      (_, index) => `/views/${"x".repeat(100)}/${index}`,
    );
    const calls: ReadonlyArray<string>[] = [];
    const storage = yield* RiftriWorktrees.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: ({ args }) => {
          calls.push(args);
          assert.equal(args[1], "inspect", "a later foreign mount must prevent every repair");
          assert.isBelow(Buffer.byteLength(args.join(" ")), 8192);
          const paths = args.slice(args.indexOf("--") + 1);
          return Effect.succeed(
            inspection(
              paths.map((destination) =>
                inspectionView(
                  destination,
                  destination === destinations.at(-1) ? "foreign" : "recovery-required",
                ),
              ),
            ),
          );
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
    );
    assert.isTrue(
      Result.isFailure(yield* storage.restore({ cwd: "/repo", destinations }).pipe(Effect.result)),
    );
    assert.isAbove(calls.length, 1);
    assert.deepEqual(
      calls.flatMap((args) => args.slice(args.indexOf("--") + 1)),
      destinations,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "restart restores missing mounts once per state even in git mode and rechecks readiness",
  () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      let checks = 0;
      const storage = yield* RiftriWorktrees.make("git").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ args }) => {
            calls.push(args);
            if (args[0] === "repair")
              return Effect.succeed(output(0, { schema_version: 1, errors: [] }));
            checks++;
            return Effect.succeed(
              inspection([
                inspectionView("/view-a", checks === 1 ? "recovery-required" : "active"),
                inspectionView("/view-b", checks === 1 ? "recovery-required" : "active"),
              ]),
            );
          },
        }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      yield* storage.restore({ cwd: "/repo", destinations: ["/view-a", "/view-b", "/view-a"] });
      assert.deepEqual(
        calls.map((args) => args.slice(0, 2)),
        [
          ["worktree", "inspect"],
          ["repair", "--state-dir=/storage/state"],
          ["worktree", "inspect"],
        ],
      );
      assert.deepEqual(calls[0]!.slice(calls[0]!.indexOf("--") + 1), ["/view-a", "/view-b"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("restart does not repair native clones, active mounts, or unmanaged directories", () =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    const storage = yield* RiftriWorktrees.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: ({ args }) => {
          calls.push(args);
          return Effect.succeed(
            inspection([
              inspectionView("/native"),
              inspectionView("/mounted", "active"),
              {
                ...inspectionView("/ordinary"),
                state_directory: null,
                state_directory_native_hex: null,
                backend: null,
              },
            ]),
          );
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
    );
    yield* storage.restore({ cwd: "/repo", destinations: [] });
    assert.equal(calls.length, 0);
    yield* storage.restore({ cwd: "/repo", destinations: ["/native", "/mounted", "/ordinary"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1], "inspect");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "restart refuses unsafe, incomplete, mismatched, or lossy inspection without repair",
  () =>
    Effect.gen(function* () {
      const view = inspectionView("/view", "recovery-required");
      const reports = [
        output(1, undefined),
        output(0, {}),
        inspection([]),
        inspection([view, view]),
        ...["foreign", "different-namespace", "unavailable"].map((status) =>
          inspection([inspectionView("/view", status)]),
        ),
        inspection([{ ...view, path: "/other" }]),
        inspection([{ ...view, path_native_hex: "ff" }]),
        inspection([{ ...view, state_directory_native_hex: "ff" }]),
        inspection([{ ...view, mount_status: null }]),
        inspection([{ ...view, backend: null }]),
        inspection([{ ...view, state_directory: null, state_directory_native_hex: null }]),
        inspection([{ ...view, backend: "reflink" }]),
      ];
      for (const report of reports) {
        let calls = 0;
        const storage = yield* RiftriWorktrees.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => {
              calls++;
              return Effect.succeed(report);
            },
          }),
          Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
        );
        assert.isTrue(
          Result.isFailure(
            yield* storage.restore({ cwd: "/repo", destinations: ["/view"] }).pipe(Effect.result),
          ),
        );
        assert.equal(calls, 1, "unsafe inspection must not initiate repair");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a successful repair is insufficient when readiness or ownership changed", () =>
  Effect.gen(function* () {
    for (const after of [
      inspectionView("/view", "recovery-required"),
      inspectionView("/view", "foreign"),
      {
        ...inspectionView("/view", "active"),
        state_directory: "/other",
        state_directory_native_hex: Buffer.from("/other").toString("hex"),
      },
      {
        ...inspectionView("/view"),
        state_directory: null,
        state_directory_native_hex: null,
        backend: null,
      },
      inspectionView("/view"),
    ]) {
      let checks = 0;
      const storage = yield* RiftriWorktrees.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ args }) => {
            if (args[0] === "repair")
              return Effect.succeed(output(0, { schema_version: 1, errors: [] }));
            return Effect.succeed(
              inspection([++checks === 1 ? inspectionView("/view", "recovery-required") : after]),
            );
          },
        }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      assert.isTrue(
        Result.isFailure(
          yield* storage.restore({ cwd: "/repo", destinations: ["/view"] }).pipe(Effect.result),
        ),
      );
      assert.equal(checks, 2);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("git mode still routes managed removal through its exact owning state", () =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    const stateDirectory = "/storage/other-repository-state";
    const storage = yield* RiftriWorktrees.make("git").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input.args);
          return Effect.succeed(
            input.args[1] === "owner"
              ? output(0, {
                  schema_version: 1,
                  state_directory: stateDirectory,
                  state_directory_native_hex: Buffer.from(stateDirectory).toString("hex"),
                  native_path_encoding: "unix-bytes-hex",
                })
              : output(0, {}),
          );
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
    );
    assert.isNull(yield* storage.create({ cwd: "/repo", destination: "/view", revision: "main" }));
    assert.equal(calls.length, 0);
    assert.isTrue(yield* storage.remove({ cwd: "/repo", destination: "/view", force: true }));
    assert.deepEqual(
      calls.map((args) => args[1]),
      ["owner", "remove"],
    );
    assert.include(calls[1]!, `--state-dir=${stateDirectory}`);
    assert.include(calls[1]!, "--force");
    assert.include(calls[1]!, "--yes");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("failed, malformed, or lossy ownership never permits ordinary removal", () =>
  Effect.gen(function* () {
    for (const report of [
      output(1, undefined),
      output(0, {}),
      output(0, {
        schema_version: 1,
        state_directory: "/state/�",
        state_directory_native_hex: "ff",
        native_path_encoding: "unix-bytes-hex",
      }),
      output(0, {
        schema_version: 1,
        state_directory: null,
        state_directory_native_hex: "00",
        native_path_encoding: "unix-bytes-hex",
      }),
    ]) {
      let calls = 0;
      const storage = yield* RiftriWorktrees.make("git").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => {
            calls++;
            return Effect.succeed(report);
          },
        }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      assert.isTrue(
        Result.isFailure(
          yield* storage.remove({ cwd: "/repo", destination: "/view" }).pipe(Effect.result),
        ),
      );
      assert.equal(calls, 1);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("interruption repairs the journal without force-removing a possibly completed view", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const started = yield* Deferred.make<void>();
    const calls: ReadonlyArray<string>[] = [];
    const storage = yield* RiftriWorktrees.make("riftri").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input.args);
          if (input.args[0] === "repair")
            return Effect.succeed(output(0, { schema_version: 1, errors: [] }));
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
    );
    const fiber = yield* storage
      .create({ cwd, destination: path.join(cwd, "view"), revision: "main", branch: "topic" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["worktree", "add"],
        ["repair", `--state-dir=${path.join(cwd, ".t3-riftri")}`],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a failed checkout hook never selects ordinary Git fallback", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const destination = path.join(cwd, "view");
    const commands: ReadonlyArray<string>[] = [];
    const storage = yield* RiftriWorktrees.make("auto").pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          commands.push(input.args);
          return Effect.succeed(
            output(3, {
              schema_version: 1,
              destination,
              backend: "apfs-clone",
              reused_base: false,
              post_checkout: { exit_code: 3 },
            }),
          );
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
    );
    const result = yield* storage
      .create({ cwd, destination, revision: "main", branch: "topic" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure.reason, "hook-failed");
    assert.equal(commands.filter((args) => args[0] === "worktree" && args[1] === "add").length, 1);
    assert.equal(commands.length, 1, "the native add already preflights its exact target tree");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["branch-already-exists", "branch-checked-out", "destination-exists"] as const)(
  "preserves the %s conflict without retrying or parsing human diagnostics",
  (code) =>
    Effect.gen(function* () {
      let calls = 0;
      const receipt = {
        schemaVersion: 1,
        outcome: "failed",
        operation: "worktree-add",
        category: "policy",
        code,
        cleanup: "not-needed",
        recovery: "not-required",
        message: "arbitrary native diagnostic that must not reach the public error",
      };
      for (const mode of ["auto", "riftri"] as const) {
        const storage = yield* RiftriWorktrees.make(mode).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => {
              calls++;
              return Effect.succeed(output(3, undefined, JSON.stringify(receipt)));
            },
          }),
          Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
        );
        const result = yield* storage
          .create({ cwd: "/repo", destination: "/view", revision: "main", branch: "topic" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.reason, code);
          assert.notInclude(result.failure.message, receipt.message);
        }
      }
      assert.equal(calls, 2, "one native add per request; no preflight or retry");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uncertain conflict receipts remain operational failures", () =>
  Effect.gen(function* () {
    const receipt = {
      schemaVersion: 1,
      outcome: "failed",
      operation: "worktree-add",
      category: "policy",
      code: "branch-already-exists",
      cleanup: "not-needed",
      recovery: "not-required",
    };
    for (const failure of [
      output(1, undefined, JSON.stringify(receipt)),
      { ...output(3, undefined, JSON.stringify(receipt)), timedOut: true },
      output(3, {}, JSON.stringify(receipt)),
      output(3, undefined, JSON.stringify({ ...receipt, category: "operational" })),
      output(3, undefined, JSON.stringify({ ...receipt, cleanup: "unknown" })),
      output(3, undefined, JSON.stringify({ ...receipt, recovery: "required" })),
      output(3, undefined, JSON.stringify({ ...receipt, operation: "worktree-remove" })),
      output(3, undefined, "branch-already-exists"),
    ]) {
      let calls = 0;
      const storage = yield* RiftriWorktrees.make("auto").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => {
            calls++;
            return Effect.succeed(failure);
          },
        }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      const result = yield* storage
        .create({ cwd: "/repo", destination: "/view", revision: "main", branch: "topic" })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.reason, "failed");
      assert.equal(calls, 1);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("only an unsupported checkout receipt permits automatic fallback", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const receipt = {
      schemaVersion: 1,
      outcome: "failed",
      operation: "worktree-add",
      category: "policy",
      code: "unsupported-checkout",
      cleanup: "not-needed",
      recovery: "not-required",
    };
    for (const failure of [
      output(3, undefined, JSON.stringify(receipt)),
      output(3, undefined),
      output(1, undefined, JSON.stringify({ ...receipt, category: "operational" })),
      output(3, undefined, JSON.stringify({ ...receipt, code: "stale-state-registration" })),
    ]) {
      const storage = yield* RiftriWorktrees.make("auto").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.succeed(failure) }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      const result = yield* storage
        .create({ cwd, destination: path.join(cwd, "view"), revision: "main", branch: "topic" })
        .pipe(Effect.result);
      if (failure.stderr === JSON.stringify(receipt)) {
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success, null);
      } else {
        assert.isTrue(Result.isFailure(result));
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "cached creation does not scan and repair the entire state before native validation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(cwd, ".t3-riftri"));
      const destination = path.join(cwd, "view");
      const calls: ReadonlyArray<string>[] = [];
      const storage = yield* RiftriWorktrees.make("auto").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            calls.push(input.args);
            return Effect.succeed(
              output(
                0,
                input.args[0] === "repair"
                  ? { schema_version: 1, errors: [] }
                  : {
                      schema_version: 1,
                      destination,
                      backend: "apfs-clone",
                      reused_base: true,
                      post_checkout: null,
                    },
              ),
            );
          },
        }),
        Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      );
      yield* storage.create({ cwd, destination, revision: "main", branch: "topic" });
      assert.deepEqual(
        calls.map((args) => args.slice(0, 2)),
        [["worktree", "add"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "remote guessing never bypasses a managed destination or failed ownership discovery",
  () =>
    Effect.gen(function* () {
      const stateDirectory = "/state";
      for (const owner of [
        output(1, undefined),
        output(0, {}),
        output(0, {
          schema_version: 1,
          state_directory: stateDirectory,
          state_directory_native_hex: Buffer.from(stateDirectory).toString("hex"),
          native_path_encoding: "unix-bytes-hex",
        }),
      ]) {
        const calls: string[] = [];
        const storage = yield* RiftriWorktrees.make("auto").pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) => {
              calls.push(input.command === "git" ? input.args[0]! : input.args[1]!);
              return Effect.succeed(input.command === "git" ? output(1, undefined) : owner);
            },
          }),
          Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
        );
        assert.isTrue(
          Result.isFailure(
            yield* storage
              .create({ cwd: "/repo", destination: "/view", revision: "remote-only" })
              .pipe(Effect.result),
          ),
        );
        assert.deepEqual(calls, ["show-ref", "check-ref-format", "rev-parse", "owner"]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!process.env.T3CODE_TEST_RIFTRI_BINARY)(
  "real native worktrees reuse a base, isolate writes, and preserve dirty work",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-riftri-native-" });
      const cwd = path.join(root, "repo");
      yield* fs.makeDirectory(cwd);
      const environment = {
        ...process.env,
        RIFTRI_BINARY: process.env.T3CODE_TEST_RIFTRI_BINARY,
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      const runner = yield* ProcessRunner.make();
      const git = (args: ReadonlyArray<string>, directory = cwd) =>
        runner
          .run({ command: "git", args, cwd: directory, env: environment })
          .pipe(
            Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))),
          );
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.name", "T3 test"]);
      yield* git(["config", "user.email", "t3@example.invalid"]);
      yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "original\n");
      yield* git(["add", "."]);
      yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
      const storage = yield* RiftriWorktrees.make("riftri").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcessEnvironment, environment),
      );
      const firstPath = path.join(root, "first");
      const secondPath = path.join(root, "second");
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const destination of [firstPath, secondPath]) {
            if (yield* fs.exists(destination))
              yield* storage.remove({ cwd, destination, force: true });
          }
          const collected = yield* runner.run({
            command: environment.RIFTRI_BINARY!,
            args: ["gc", "--apply", "--yes", `--state-dir=${path.join(root, ".t3-riftri")}`],
            cwd,
            env: environment,
          });
          assert.equal(collected.code, 0, collected.stderr);
        }).pipe(Effect.orDie),
      );
      const first = yield* storage.create({
        cwd,
        destination: firstPath,
        branch: "first",
        revision: "main",
      });
      const second = yield* storage.create({
        cwd,
        destination: secondPath,
        branch: "second",
        revision: "main",
      });
      assert.isNotNull(first);
      assert.isNotNull(second);
      assert.equal(first?.reused_base, false);
      assert.equal(second?.reused_base, true);
      yield* storage.restore({ cwd, destinations: [firstPath, secondPath] });
      assert.equal((yield* git(["status", "--porcelain"], firstPath)).stdout, "");
      assert.equal((yield* git(["status", "--porcelain"], secondPath)).stdout, "");
      assert.equal(
        (yield* git(["rev-parse", "HEAD"], secondPath)).stdout,
        (yield* git(["rev-parse", "HEAD"])).stdout,
      );
      yield* fs.writeFileString(path.join(firstPath, "tracked.txt"), "private edit\n");
      assert.equal(yield* fs.readFileString(path.join(secondPath, "tracked.txt")), "original\n");
      assert.equal(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "original\n");
      assert.isTrue(
        Result.isFailure(
          yield* storage.remove({ cwd, destination: firstPath }).pipe(Effect.result),
        ),
      );
      assert.equal(yield* fs.readFileString(path.join(firstPath, "tracked.txt")), "private edit\n");
      yield* fs.writeFileString(path.join(firstPath, "tracked.txt"), "original\n");
      assert.isTrue(yield* storage.remove({ cwd, destination: firstPath }));
      assert.isTrue(yield* storage.remove({ cwd, destination: secondPath }));
      assert.isFalse(yield* fs.exists(firstPath));
      yield* storage.prune(cwd);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  // Real Git processes, journal fsyncs, and APFS operations share a busy host.
  { timeout: 30_000 },
);
