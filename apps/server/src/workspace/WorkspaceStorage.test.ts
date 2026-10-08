import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspaceStorage from "./WorkspaceStorage.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";

it.effect("isolates an unverifiable workspace and allows retry after its mount is repaired", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-readiness-" });
    const broken = path.join(root, "broken");
    const healthy = path.join(root, "healthy");
    const neighbor = path.join(root, "broken-neighbor");
    const alias = path.join(root, "alias");
    for (const directory of [broken, healthy, neighbor]) yield* fs.makeDirectory(directory);
    yield* fs.symlink(broken, alias);
    let ready = false;
    const calls: ReadonlyArray<string>[] = [];
    const service = yield* WorkspaceStorage.make.pipe(
      Effect.provideService(HostProcessEnvironment, { RIFTRI_BINARY: "/test/riftri" }),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input.args);
          assert.equal(input.args[1], "inspect");
          return Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
            stdout: JSON.stringify({
              schema_version: 1,
              native_path_encoding: "unix-bytes-hex",
              worktrees: input.args.slice(input.args.indexOf("--") + 1).map((destination) => ({
                path: destination,
                path_native_hex: Buffer.from(destination).toString("hex"),
                state_directory: root,
                state_directory_native_hex: Buffer.from(root).toString("hex"),
                backend: "overlay-fs",
                mount_status: destination === broken && !ready ? "foreign" : "active",
              })),
            }),
          });
        },
      }),
    );
    yield* service.restore({ cwd: root, destinations: [broken, healthy, broken] });
    assert.equal(calls.length, 3, "one failed batch, then one inspection per distinct workspace");
    yield* service.ensureReady(healthy);
    yield* service.ensureReady(neighbor);
    assert.equal(calls.length, 3, "unrelated workspaces do not trigger native checks");
    for (const destination of [broken, path.join(alias, "new", "file.txt")]) {
      const result = yield* service.ensureReady(destination).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.workspaceRoot, broken);
    }
    const guards = Layer.succeed(WorkspaceStorage.WorkspaceStorage, service);
    const files = yield* WorkspaceFileSystem.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          guards,
          WorkspacePaths.layer,
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        ),
      ),
    );
    const write = yield* files
      .writeFile({ cwd: alias, relativePath: "new/file.txt", contents: "must not be written" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(write));
    assert.isFalse(yield* fs.exists(path.join(broken, "new")));
    yield* files.writeFile({ cwd: healthy, relativePath: "ok.txt", contents: "healthy workspace" });
    assert.equal(yield* fs.readFileString(path.join(healthy, "ok.txt")), "healthy workspace");

    const git = yield* makeGitVcsDriverCore().pipe(
      Effect.provide(Layer.merge(guards, ServerConfig.layerTest(root, path.join(root, "t3")))),
    );
    const command = yield* git
      .execute({ cwd: broken, args: ["init"], operation: "test.blockedInit" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(command));
    assert.isFalse(yield* fs.exists(path.join(broken, ".git")));

    let spawned = false;
    const terminal = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(root, "logs"),
      shellResolver: () => "/bin/sh",
      ptyAdapter: {
        spawn: () =>
          Effect.sync(() => {
            spawned = true;
            throw new Error("must not spawn");
          }),
      },
    }).pipe(Effect.provide(Layer.merge(guards, ProcessRunner.layer)));
    const opened = yield* terminal
      .open({ threadId: "blocked", terminalId: "default", cwd: broken })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(opened));
    assert.isFalse(spawned);
    ready = true;
    yield* service.ensureReady(broken);
    const verifiedCalls = calls.length;
    yield* service.ensureReady(path.join(alias, "new", "file.txt"));
    assert.equal(calls.length, verifiedCalls, "verified workspaces stay off the native hot path");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
