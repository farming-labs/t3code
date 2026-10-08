import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "./processRunner.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("restores persisted worktrees by repository before their providers can resume", () =>
  Effect.gen(function* () {
    const calls: { cwd: string | undefined; args: ReadonlyArray<string> }[] = [];
    let repaired = false;
    yield* ServerRuntimeStartup.restorePersistedWorktrees.pipe(
      Effect.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed(
              ["one", "two", "plain"].map((id) => ({
                id: ProjectId.make(id),
                title: id,
                workspaceRoot: id === "plain" ? "/not-a-repository" : "/repository",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-07T00:00:00.000Z",
                updatedAt: "2026-10-07T00:00:00.000Z",
                deletedAt: null,
              })),
            ),
        }),
      ),
      Effect.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getWorktreeRoots: () =>
            Effect.succeed([
              { projectId: ProjectId.make("one"), worktreePath: "/views/a" },
              { projectId: ProjectId.make("two"), worktreePath: "/views/a" },
              { projectId: ProjectId.make("two"), worktreePath: "/views/b" },
              {
                projectId: ProjectId.make("deleted-project"),
                worktreePath: "/views/deleted-project",
              },
            ]),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push({ cwd: input.cwd, args: input.args });
          let report: unknown;
          if (input.args[0] === "repair") {
            repaired = true;
            report = { schema_version: 1, errors: [] };
          } else {
            report = {
              schema_version: 1,
              native_path_encoding: "unix-bytes-hex",
              worktrees: input.args.slice(input.args.indexOf("--") + 1).map((path) => ({
                path,
                path_native_hex: Buffer.from(path).toString("hex"),
                state_directory: "/state",
                state_directory_native_hex: Buffer.from("/state").toString("hex"),
                backend: "overlay-fs",
                mount_status: repaired ? "active" : "recovery-required",
              })),
            };
          }
          return Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stdout: JSON.stringify(report),
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      }),
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      Effect.provide(Path.layer),
    );
    assert.deepEqual(
      calls.map(({ args }) => args.slice(0, 2)),
      [
        ["worktree", "inspect"],
        ["repair", "--state-dir=/state"],
        ["worktree", "inspect"],
      ],
    );
    assert.isTrue(calls.every(({ cwd }) => cwd === "/repository"));
    assert.deepEqual(calls[0]!.args.slice(calls[0]!.args.indexOf("--") + 1), [
      "/views/a",
      "/views/b",
    ]);
  }),
);

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      restoreWorktreeStorage: record("storage"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "storage",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("an unsafe persisted worktree prevents provider recovery and background work", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const record = (label: string) =>
      Effect.sync(() => {
        calls.push(label);
      });
    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      restoreWorktreeStorage: record("storage").pipe(
        Effect.andThen(Effect.fail("mount unavailable")),
      ),
      recover: record("recover"),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap"),
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(calls, ["import", "storage"]);
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
