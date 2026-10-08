// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import { build } from "vite-plus/pack";
import {
  isExternalCliDependency,
  RIFTRI_ASAR_UNPACK_GLOB,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";
import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const require = NodeModule.createRequire(NodePath.join(repoRoot, "apps/server/package.json"));
const electron = process.env.T3CODE_TEST_ELECTRON_BINARY;

async function probe(runtime?: string): Promise<void> {
  const scratch = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-riftri-package-")),
  );
  try {
    for (let parent = NodePath.dirname(scratch); ; parent = NodePath.dirname(parent)) {
      assert.isFalse(NodeFS.existsSync(NodePath.join(parent, "node_modules")));
      if (parent === NodePath.dirname(parent)) break;
    }
    // This proof must use the installed package, not an executable override.
    assert.isNotOk(process.env.RIFTRI_BINARY);
    const native = (require("riftri") as { resolveBinary: () => string }).resolveBinary();
    const platformRoot = NodePath.dirname(NodePath.dirname(native));
    const launcherRoot = NodePath.dirname(NodePath.dirname(require.resolve("riftri")));
    const output = NodePath.join(scratch, "package");
    const entry = NodePath.join(scratch, "probe.mjs");
    const repository = NodePath.join(scratch, "repository");
    await NodeFSP.mkdir(repository);
    const gitConfig = NodePath.join(scratch, "empty.gitconfig");
    await NodeFSP.writeFile(gitConfig, "");
    const env = {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      RIFTRI_BYPASS: "1",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(runtime ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    NodeChildProcess.execFileSync("git", ["init", "--quiet", repository], { env });
    await NodeFSP.writeFile(
      entry,
      `
      import * as Effect from ${JSON.stringify(require.resolve("effect/Effect"))};
      import * as NodeServices from ${JSON.stringify(require.resolve("@effect/platform-node/NodeServices"))};
      import * as RiftriWorktrees from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/vcs/RiftriWorktrees.ts"))};
      import * as ProcessRunner from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/processRunner.ts"))};
      await Effect.runPromise(Effect.gen(function* () {
        const storage = yield* RiftriWorktrees.make();
        yield* storage.restore({cwd: process.argv[2], destinations: [process.argv[2]]});
      }).pipe(Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)));
      console.log('Packaged storage adapter inspected the real repository.');
      `,
    );
    await build({
      config: false,
      entry: [entry],
      outDir: output,
      platform: "node",
      format: "esm",
      dts: false,
      logLevel: "error",
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: isExternalCliDependency,
        onlyBundle: false,
      },
    });
    for (const source of [launcherRoot, platformRoot]) {
      await NodeFSP.cp(source, NodePath.join(output, "node_modules", NodePath.basename(source)), {
        recursive: true,
        filter: (file) => file === source || NodePath.basename(file) !== "node_modules",
      });
    }
    const bundle = NodePath.join(output, "probe.mjs");
    assert.deepEqual(findEsmImportsOfExternalPackages(await NodeFSP.readFile(bundle, "utf8")), []);
    let executableEntry = bundle;
    if (runtime) {
      const archive = NodePath.join(scratch, "server.asar");
      await createPackageWithOptions(output, archive, { unpack: RIFTRI_ASAR_UNPACK_GLOB });
      executableEntry = NodePath.join(archive, "probe.mjs");
    }
    const stdout = NodeChildProcess.execFileSync(
      runtime ?? process.execPath,
      ["--no-global-search-paths", executableEntry, repository],
      { cwd: scratch, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.include(stdout, "Packaged storage adapter inspected the real repository.");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

it("runs the bundled storage adapter using only its staged native package", () => probe(), 60_000);

it.skipIf(!electron)(
  "runs the bundled storage adapter from an actual Electron ASAR archive",
  () => probe(electron),
  60_000,
);

it.skipIf(!process.env.T3CODE_TEST_DESKTOP_ASAR || !electron)(
  "loads the server and native dependency from the complete desktop archive",
  async () => {
    const archive = NodePath.resolve(process.env.T3CODE_TEST_DESKTOP_ASAR!);
    const scratch = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-riftri-")),
    );
    try {
      assert.isNotOk(process.env.RIFTRI_BINARY);
      assert.isTrue(NodeFS.existsSync(archive));
      assert.isFalse(archive.startsWith(`${repoRoot}${NodePath.sep}`));
      for (let parent = NodePath.dirname(archive); ; parent = NodePath.dirname(parent)) {
        assert.isFalse(NodeFS.existsSync(NodePath.join(parent, "node_modules")));
        if (parent === NodePath.dirname(parent)) break;
      }
      const env = {
        ...process.env,
        NODE_PATH: "",
        NODE_OPTIONS: "",
        ELECTRON_RUN_AS_NODE: "1",
        RIFTRI_BYPASS: "1",
        GIT_CONFIG_GLOBAL: NodePath.join(scratch, "empty.gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: undefined,
        GIT_CONFIG_PARAMETERS: undefined,
      };
      await NodeFSP.writeFile(env.GIT_CONFIG_GLOBAL, "");
      NodeChildProcess.execFileSync("git", ["init", "--quiet", scratch], { env });
      const entry = NodePath.join(archive, "apps/server/dist/bin.mjs");
      const version = NodeChildProcess.execFileSync(
        electron!,
        ["--no-global-search-paths", entry, "--version"],
        { cwd: scratch, env, encoding: "utf8", timeout: 30_000 },
      );
      assert.match(version, /\d+\.\d+\.\d+/);
      const output = NodeChildProcess.execFileSync(
        electron!,
        [
          "--no-global-search-paths",
          "-e",
          `
          const assert = require('node:assert/strict');
          const { createRequire } = require('node:module');
          const path = require('node:path');
          const server = createRequire(${JSON.stringify(entry)});
          assert(server.resolve('riftri').startsWith(${JSON.stringify(`${archive}/`)}));
          const { Riftri, resolveBinary } = server('riftri');
          const binary = resolveBinary();
          assert(binary.startsWith(${JSON.stringify(`${archive}.unpacked/`)}));
          const client = new Riftri({ repository: process.cwd() });
          client.worktree.inspect([process.cwd()]).then(report => {
            assert.equal(report.worktrees.length, 1);
            assert.equal(report.worktrees[0].state_directory, null);
            console.log('Complete desktop archive loaded the server and executed its own Riftri package.');
          }).catch(error => { console.error(error); process.exitCode = 1; });
        `,
        ],
        { cwd: scratch, env, encoding: "utf8", timeout: 30_000 },
      );
      assert.include(output, "executed its own Riftri package");
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);
