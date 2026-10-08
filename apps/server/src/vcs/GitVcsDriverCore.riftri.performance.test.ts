// @effect-diagnostics nodeBuiltinImport:off -- statfs measures shared physical allocation on an isolated test volume.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceStorage from "../workspace/WorkspaceStorage.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";

const volume = process.env.T3CODE_TEST_RIFTRI_VOLUME;
const nativeBinary = process.env.T3CODE_TEST_RIFTRI_BINARY;
const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      bases: Schema.Array(Schema.Struct({ path: Schema.String, reference_count: Schema.Number })),
      operations: Schema.Struct({ active_views: Schema.Number }),
      diagnostic_issues: Schema.Array(Schema.Unknown),
    }),
  ),
);

// Only run on the dedicated CI disk image, with no other writers. Summing du
// for cloned files double-counts shared extents and cannot prove a saving.
it.effect.skipIf(!volume || !nativeBinary)(
  "measures released worktree storage and latency through the real T3 driver",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isNotOk(process.env.RIFTRI_BINARY);
      assert.notEqual(NodeFS.statSync(volume!).dev, NodeFS.statSync(process.cwd()).dev);
      const root = yield* fs.makeTempDirectoryScoped({
        directory: volume!,
        prefix: "t3-riftri-benchmark-",
      });
      const cwd = path.join(root, "repository");
      yield* fs.makeDirectory(cwd);
      const environment = {
        ...process.env,
        RIFTRI_BINARY: undefined,
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_COUNT: undefined,
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      const runner = yield* ProcessRunner.make();
      const run = (command: string, args: ReadonlyArray<string>, directory = cwd) =>
        runner.run({ command, args, cwd: directory, env: environment }).pipe(
          Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))),
          Effect.map((result) => result.stdout),
        );
      const git = (args: ReadonlyArray<string>, directory = cwd) => run("git", args, directory);
      const used = () => {
        const stat = NodeFS.statfsSync(volume!, { bigint: true });
        return Number((stat.blocks - stat.bfree) * stat.bsize);
      };
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.name", "T3 benchmark"]);
      yield* git(["config", "user.email", "t3@example.invalid"]);
      const original = "private writes must not change the shared base\n";
      yield* fs.writeFileString(path.join(cwd, "README.md"), original);
      // An incompressible payload plus many small files exercises both data
      // sharing and per-file metadata. This is a fixture, not a user-repo claim.
      yield* fs.writeFile(path.join(cwd, "payload.bin"), NodeCrypto.randomBytes(32 * 1024 * 1024));
      for (let index = 0; index < 256; index++) {
        yield* fs.writeFileString(
          path.join(cwd, `file-${index}.txt`),
          `${index}\n${"source\n".repeat(680)}`,
        );
      }
      yield* git(["add", "."]);
      yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
      const head = (yield* git(["rev-parse", "HEAD"])).trim();
      const version = (yield* run(nativeBinary!, ["--version"])).trim();
      const measurements: {
        mode: string;
        physicalBytes: number;
        incrementalBytes: number[];
        creationMilliseconds: number[];
      }[] = [];
      for (const mode of ["git", "riftri"] as const) {
        const directory = path.join(root, mode);
        yield* fs.makeDirectory(directory);
        const stateDir = path.join(directory, ".t3-riftri");
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provide(
            Layer.merge(WorkspaceStorage.layer, ServerConfig.layerTest(cwd, path.join(root, "t3"))),
          ),
          Effect.provideService(HostProcessEnvironment, {
            ...environment,
            T3CODE_WORKTREE_STORAGE: mode,
          }),
        );
        const destinations = Array.from({ length: 3 }, (_, index) =>
          path.join(directory, `view-${index}`),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (mode === "riftri" && (yield* fs.exists(stateDir))) {
                  yield* run(nativeBinary!, ["repair", `--state-dir=${stateDir}`]);
                }
                for (const destination of destinations) {
                  if (yield* fs.exists(destination)) {
                    yield* driver.removeWorktree({ cwd, path: destination, force: true });
                  }
                }
                if (mode === "riftri" && (yield* fs.exists(stateDir))) {
                  yield* run(nativeBinary!, ["gc", "--apply", "--yes", `--state-dir=${stateDir}`]);
                  const empty = yield* decodeStatus(
                    yield* run(nativeBinary!, ["status", "--json", `--state-dir=${stateDir}`]),
                  );
                  assert.equal(empty.operations.active_views, 0);
                  assert.equal(empty.bases.length, 0);
                }
              }).pipe(Effect.orDie),
            );
            yield* run("sync", []);
            const baseline = used();
            let previous = baseline;
            const incrementalBytes: number[] = [];
            const creationMilliseconds: number[] = [];
            for (const [index, destination] of destinations.entries()) {
              // Use wall time, not Effect's virtual test clock. Report latency
              // without a flaky threshold or an assumed speedup.
              const start = performance.now();
              yield* driver.createWorktree({
                cwd,
                path: destination,
                refName: "main",
                newRefName: `benchmark-${mode}-${index}`,
              });
              creationMilliseconds.push(performance.now() - start);
              assert.equal(yield* git(["status", "--porcelain"], destination), "");
              assert.equal((yield* git(["rev-parse", "HEAD"], destination)).trim(), head);
              yield* run("sync", []);
              const current = used();
              incrementalBytes.push(current - previous);
              previous = current;
            }
            measurements.push({
              mode,
              physicalBytes: previous - baseline,
              incrementalBytes,
              creationMilliseconds,
            });
            if (mode === "riftri") {
              const status = yield* decodeStatus(
                yield* run(nativeBinary!, ["status", "--json", `--state-dir=${stateDir}`]),
              );
              assert.equal(status.bases.length, 1);
              assert.equal(status.bases[0]!.reference_count, 3);
              assert.equal(status.operations.active_views, 3);
              assert.equal(status.diagnostic_issues.length, 0);
              yield* fs.writeFileString(path.join(destinations[0]!, "README.md"), "private edit\n");
              assert.equal(
                yield* fs.readFileString(path.join(destinations[1]!, "README.md")),
                original,
              );
              assert.equal(
                yield* fs.readFileString(path.join(status.bases[0]!.path, "README.md")),
                original,
              );
              yield* fs.writeFileString(path.join(destinations[0]!, "README.md"), original);
            }
          }),
        );
      }
      const savingPercent =
        100 * (1 - measurements[1]!.physicalBytes / measurements[0]!.physicalBytes);
      const report = JSON.stringify(
        {
          version,
          backend: process.env.T3CODE_TEST_RIFTRI_BACKEND,
          views: 3,
          fixture: "32 MiB incompressible payload and 257 text files",
          driver: "GitVcsDriverCore",
          includesColdBase: true,
          measurements,
          savingPercent,
          timingNote:
            "Single-run cold-base then two cached-base adds; no assumed latency improvement.",
        },
        null,
        2,
      );
      yield* Effect.log(report);
      if (process.env.T3CODE_TEST_RIFTRI_REPORT) {
        yield* fs.writeFileString(process.env.T3CODE_TEST_RIFTRI_REPORT, report);
      }
      assert.isAbove(measurements[0]!.physicalBytes, 0);
      assert.isAbove(measurements[1]!.physicalBytes, 0);
      assert.isAbove(savingPercent, 40);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
