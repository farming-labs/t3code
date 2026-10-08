import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";

const nativeBinary = process.env.T3CODE_TEST_RIFTRI_BINARY;
// The packaged pass must resolve the installed dependency through the driver,
// while fixture cleanup can still address that package's executable directly.
const packaged = process.env.T3CODE_TEST_RIFTRI_PACKAGE === "1";

it.effect.skipIf(!process.env.T3CODE_TEST_RIFTRI_BINARY)(
  "native preflight conflicts preserve Git driver error reasons and existing content",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-riftri-conflicts-" });
      const cwd = path.join(root, "repository");
      yield* fs.makeDirectory(cwd);
      const environment = {
        ...process.env,
        RIFTRI_BINARY: packaged ? undefined : nativeBinary,
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      const runner = yield* ProcessRunner.make();
      const git = (args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args, cwd, env: environment }).pipe(
          Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))),
          Effect.map((result) => result.stdout),
        );
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.name", "T3 test"]);
      yield* git(["config", "user.email", "t3@example.invalid"]);
      yield* git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
      yield* git(["branch", "taken"]);
      const occupiedFile = path.join(root, "file");
      const occupiedDirectory = path.join(root, "directory");
      yield* fs.writeFileString(occupiedFile, "preserve file");
      yield* fs.makeDirectory(occupiedDirectory);
      yield* fs.writeFileString(path.join(occupiedDirectory, "keep.txt"), "preserve directory");
      const worktreesBefore = yield* git(["worktree", "list", "--porcelain"]);
      const config = ServerConfig.layerTest(cwd, path.join(root, "t3"));
      let claimed = 0;
      for (const mode of ["git", "auto", "riftri"] as const) {
        const branchesBefore = yield* git(["show-ref"]);
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provide(config),
          Effect.provideService(HostProcessEnvironment, {
            ...environment,
            T3CODE_WORKTREE_STORAGE: mode,
          }),
        );
        for (const { input, reason } of [
          {
            input: { cwd, path: path.join(root, "branch"), refName: "main", newRefName: "taken" },
            reason: "branch_already_exists",
          },
          {
            input: { cwd, path: path.join(root, "busy"), refName: "main" },
            reason: "branch_checked_out_in_worktree",
          },
          {
            input: { cwd, path: occupiedFile, refName: "main", newRefName: `${mode}-unused-file` },
            reason: "path_already_exists",
          },
          {
            input: {
              cwd,
              path: occupiedDirectory,
              refName: "main",
              newRefName: `${mode}-unused-dir`,
            },
            reason: "path_already_exists",
          },
        ]) {
          const result = yield* driver
            .createWorktree(input, {
              progress: {
                onWorktreeClaimed: () =>
                  Effect.sync(() => {
                    claimed++;
                  }),
              },
            })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.equal(result.failure.reason, reason, `${mode}: ${result.failure.message}`);
          }
        }
        // Plain Git may create the requested branch before rejecting an
        // occupied path. Native preflight must not introduce that side effect.
        if (mode !== "git") assert.equal(yield* git(["show-ref"]), branchesBefore);
      }
      assert.equal(claimed, 0);
      assert.equal(yield* git(["worktree", "list", "--porcelain"]), worktreesBefore);
      assert.equal(yield* fs.readFileString(occupiedFile), "preserve file");
      assert.equal(
        yield* fs.readFileString(path.join(occupiedDirectory, "keep.txt")),
        "preserve directory",
      );
      assert.isFalse(yield* fs.exists(path.join(root, ".t3-riftri")));
      assert.isFalse(yield* fs.exists(path.join(root, "branch")));
      assert.isFalse(yield* fs.exists(path.join(root, "busy")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.effect.skipIf(!process.env.T3CODE_TEST_RIFTRI_BINARY)(
  "the shared Git driver creates managed worktrees and keeps managed cleanup in git mode",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-core-riftri-" });
      const cwd = path.join(root, "repository");
      yield* fs.makeDirectory(cwd);
      const environment = {
        ...process.env,
        RIFTRI_BINARY: packaged ? undefined : nativeBinary,
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        T3CODE_WORKTREE_STORAGE: "riftri",
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
      const config = ServerConfig.layerTest(cwd, path.join(root, "t3"));
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provide(config),
        Effect.provideService(HostProcessEnvironment, environment),
      );
      const destination = path.join(root, "view");
      // Bases are intentionally immutable. Always retire the fixture through
      // the lifecycle before the temporary-directory finalizer removes it.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const repaired = yield* runner.run({
            command: nativeBinary!,
            args: ["repair", `--state-dir=${path.join(root, ".t3-riftri")}`],
            cwd,
            env: environment,
          });
          assert.equal(repaired.code, 0, repaired.stderr);
          if (yield* fs.exists(destination)) {
            yield* driver.removeWorktree({ cwd, path: destination, force: true });
          }
          const collected = yield* runner.run({
            command: nativeBinary!,
            args: ["gc", "--apply", "--yes", `--state-dir=${path.join(root, ".t3-riftri")}`],
            cwd,
            env: environment,
          });
          assert.equal(collected.code, 0, collected.stderr);
        }).pipe(Effect.orDie),
      );
      const claimed: string[] = [];
      const created = yield* driver.createWorktree(
        { cwd, path: destination, refName: "main", newRefName: "topic" },
        {
          progress: {
            onWorktreeClaimed: (view) =>
              Effect.sync(() => {
                claimed.push(view);
              }),
          },
        },
      );
      assert.equal(created.worktree.path, destination);
      assert.deepEqual(claimed, [destination]);
      const owner = yield* runner.run({
        command: nativeBinary!,
        args: ["worktree", "owner", "--json", "--", destination],
        cwd,
        env: environment,
      });
      assert.equal(owner.code, 0, owner.stderr);
      assert.include(owner.stdout, ".t3-riftri");
      assert.equal((yield* git(["status", "--porcelain"], destination)).stdout, "");
      const restarted = yield* makeGitVcsDriverCore().pipe(
        Effect.provide(config),
        Effect.provideService(HostProcessEnvironment, {
          ...environment,
          T3CODE_WORKTREE_STORAGE: "git",
        }),
      );
      yield* fs.writeFileString(path.join(destination, "tracked.txt"), "private edit\n");
      assert.isTrue(
        Result.isFailure(
          yield* restarted.removeWorktree({ cwd, path: destination }).pipe(Effect.result),
        ),
      );
      assert.equal(
        yield* fs.readFileString(path.join(destination, "tracked.txt")),
        "private edit\n",
      );
      yield* fs.writeFileString(path.join(destination, "tracked.txt"), "original\n");
      yield* restarted.removeWorktree({ cwd, path: destination });
      yield* restarted.pruneWorktrees({ cwd });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.effect.each([
  "HEAD",
  "commit",
  "tag",
  "topic",
  "refs/heads/topic",
  "origin/topic",
  "remote-only",
  "ambiguous",
  "@{-1}",
  "submodule-tree",
])(
  "matches ordinary Git's worktree reference semantics for %s",
  (reference) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-riftri-refs-" });
      const cwd = path.join(root, "repository");
      yield* fs.makeDirectory(cwd);
      const environment = {
        ...process.env,
        RIFTRI_BINARY: packaged ? undefined : nativeBinary,
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        T3CODE_WORKTREE_STORAGE: "auto",
      };
      const runner = yield* ProcessRunner.make();
      const git = (args: ReadonlyArray<string>, directory = cwd) =>
        runner.run({ command: "git", args, cwd: directory, env: environment }).pipe(
          Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))),
          Effect.map((result) => result.stdout.trim()),
        );
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.name", "T3 test"]);
      yield* git(["config", "user.email", "t3@example.invalid"]);
      yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "original\n");
      yield* git(["add", "."]);
      yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
      const commit = yield* git(["rev-parse", "HEAD"]);
      yield* git(["branch", "topic"]);
      yield* git(["tag", "tag"]);
      yield* git(["remote", "add", "origin", cwd]);
      yield* git(["update-ref", "refs/remotes/origin/topic", commit]);
      yield* git(["update-ref", "refs/remotes/origin/remote-only", commit]);
      if (reference === "ambiguous") {
        yield* git(["tag", "ambiguous"]);
        yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "branch differs from tag\n");
        yield* git(["-c", "commit.gpgsign=false", "commit", "-am", "branch change"]);
        yield* git(["branch", "ambiguous"]);
      }
      if (reference === "@{-1}") {
        yield* git(["switch", "topic"]);
        yield* git(["switch", "main"]);
      }
      if (reference === "submodule-tree") {
        yield* fs.writeFileString(
          path.join(cwd, ".gitmodules"),
          '[submodule "child"]\n\tpath = child\n\turl = ./child.git\n',
        );
        yield* git(["add", ".gitmodules"]);
        yield* git(["update-index", "--add", "--cacheinfo", `160000,${commit},child`]);
        yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "submodule"]);
        yield* git(["branch", "submodule-tree"]);
      }
      const refName = reference === "commit" ? commit : reference;
      const destination = path.join(root, "view");
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provide(ServerConfig.layerTest(cwd, path.join(root, "t3"))),
        Effect.provideService(HostProcessEnvironment, environment),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* fs.exists(destination)) {
            yield* driver.removeWorktree({ cwd, path: destination, force: true });
          }
          if (!(yield* fs.exists(path.join(root, ".t3-riftri")))) return;
          const collected = yield* runner.run({
            command: nativeBinary!,
            args: ["gc", "--apply", "--yes", `--state-dir=${path.join(root, ".t3-riftri")}`],
            cwd,
            env: environment,
          });
          assert.equal(collected.code, 0, collected.stderr);
        }).pipe(Effect.orDie),
      );
      yield* git(["worktree", "add", destination, refName]);
      const expectedCommit = yield* git(["rev-parse", "HEAD"], destination);
      const expectedBranch = yield* git(["branch", "--show-current"], destination);
      const expectedTracking = yield* git([
        "for-each-ref",
        "--format=%(upstream)",
        `refs/heads/${expectedBranch}`,
      ]);
      yield* git(["worktree", "remove", destination]);
      if (reference === "remote-only") yield* git(["branch", "-D", "remote-only"]);

      yield* driver.createWorktree({ cwd, path: destination, refName }, { submodules: "none" });
      assert.equal(yield* git(["rev-parse", "HEAD"], destination), expectedCommit);
      assert.equal(yield* git(["branch", "--show-current"], destination), expectedBranch);
      assert.equal(
        yield* git(["for-each-ref", "--format=%(upstream)", `refs/heads/${expectedBranch}`]),
        expectedTracking,
      );
      assert.equal(yield* git(["status", "--porcelain"], destination), "");
      const owner = yield* runner.run({
        command: nativeBinary!,
        args: ["worktree", "owner", "--json", "--", destination],
        cwd,
        env: environment,
      });
      assert.equal(owner.code, 0, owner.stderr);
      if (reference === "remote-only" || reference === "submodule-tree") {
        assert.include(owner.stdout, '"state_directory": null');
      } else {
        assert.include(owner.stdout, ".t3-riftri");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 30_000, skip: !process.env.T3CODE_TEST_RIFTRI_BINARY },
);
