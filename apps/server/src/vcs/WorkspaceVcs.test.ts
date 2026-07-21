import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorkspaceVcs from "./WorkspaceVcs.ts";
import { WORKTREE_WORKSPACE_MANIFEST_FILENAME } from "./WorkspaceVcs.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workspace-vcs-test-",
});
const TestLayer = WorkspaceVcs.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "workspace-vcs-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorkspaceVcs.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(pathService.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

const makeMultiRepoWorkspace = (
  workspaceRoot: string,
): Effect.Effect<
  { readonly alphaRoot: string; readonly betaRoot: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const alphaRoot = pathService.join(workspaceRoot, "alpha");
    const betaRoot = pathService.join(workspaceRoot, "beta");
    yield* fileSystem.makeDirectory(alphaRoot, { recursive: true });
    yield* fileSystem.makeDirectory(betaRoot, { recursive: true });
    yield* initRepoWithCommit(alphaRoot);
    yield* initRepoWithCommit(betaRoot);
    // Non-repo noise that discovery must skip.
    yield* fileSystem.makeDirectory(pathService.join(workspaceRoot, "node_modules"));
    yield* fileSystem.makeDirectory(pathService.join(workspaceRoot, ".cache"));
    yield* fileSystem.makeDirectory(pathService.join(workspaceRoot, "not-a-repo"));
    yield* fileSystem.writeFileString(pathService.join(workspaceRoot, "notes.txt"), "notes\n");
    return { alphaRoot, betaRoot };
  });

it.layer(TestLayer)("WorkspaceVcs", (it) => {
  it.effect("classifies a git repository root as a single repository", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;
      const pathService = yield* Path.Path;

      const result = yield* workspaceVcs.listRepositories({ cwd });

      assert.equal(result.kind, "repository");
      assert.equal(result.repositories.length, 1);
      assert.equal(result.repositories[0]?.name, pathService.basename(cwd));
      assert.equal(result.repositories[0]?.root, cwd);
      assert.equal(result.repositories[0]?.relativePath, "");
    }),
  );

  it.effect("discovers child repositories in a multi-repo workspace", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTmpDir();
      const { alphaRoot, betaRoot } = yield* makeMultiRepoWorkspace(workspaceRoot);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const result = yield* workspaceVcs.listRepositories({
        cwd: workspaceRoot,
      });

      assert.equal(result.kind, "workspace");
      assert.deepEqual(
        result.repositories.map((repository) => repository.name),
        ["alpha", "beta"],
      );
      assert.deepEqual(
        result.repositories.map((repository) => repository.root),
        [alphaRoot, betaRoot],
      );
      assert.deepEqual(
        result.repositories.map((repository) => repository.relativePath),
        ["alpha", "beta"],
      );
    }),
  );

  it.effect("reports folders without repositories as none", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const result = yield* workspaceVcs.listRepositories({ cwd });

      assert.equal(result.kind, "none");
      assert.equal(result.repositories.length, 0);
    }),
  );

  it.effect("creates a worktree workspace with one worktree per repository", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTmpDir();
      yield* makeMultiRepoWorkspace(workspaceRoot);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;

      const created = yield* workspaceVcs.createWorktreeWorkspace({
        projectCwd: workspaceRoot,
        branch: "t3/feature-1",
      });

      assert.equal(created.branch, "t3/feature-1");
      assert.deepEqual(
        created.repositories.map((repository) => repository.name),
        ["alpha", "beta"],
      );
      for (const repository of created.repositories) {
        assert.equal(repository.root, pathService.join(created.workspacePath, repository.name));
        assert.equal(yield* git(repository.root, ["branch", "--show-current"]), "t3/feature-1");
      }
      assert.isTrue(
        yield* fileSystem.exists(
          pathService.join(created.workspacePath, WORKTREE_WORKSPACE_MANIFEST_FILENAME),
        ),
      );

      // The workspace itself is discoverable as a multi-repo workspace.
      const rediscovered = yield* workspaceVcs.listRepositories({
        cwd: created.workspacePath,
      });
      assert.equal(rediscovered.kind, "workspace");
      assert.deepEqual(
        rediscovered.repositories.map((repository) => repository.name),
        ["alpha", "beta"],
      );

      yield* workspaceVcs.removeWorktreeWorkspaceIfPresent({
        path: created.workspacePath,
      });
    }),
  );

  it.effect("rejects creating a worktree workspace for a single repository root", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const result = yield* workspaceVcs
        .createWorktreeWorkspace({ projectCwd: cwd, branch: "t3/feature-1" })
        .pipe(Effect.flip);

      assert.instanceOf(result, GitCommandError);
    }),
  );

  it.effect("removes a worktree workspace and its repository worktrees", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTmpDir();
      const { alphaRoot } = yield* makeMultiRepoWorkspace(workspaceRoot);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;
      const fileSystem = yield* FileSystem.FileSystem;

      const created = yield* workspaceVcs.createWorktreeWorkspace({
        projectCwd: workspaceRoot,
        branch: "t3/feature-2",
      });

      const removed = yield* workspaceVcs.removeWorktreeWorkspaceIfPresent({
        path: created.workspacePath,
      });

      assert.isTrue(removed);
      assert.isFalse(yield* fileSystem.exists(created.workspacePath));
      const worktrees = yield* git(alphaRoot, ["worktree", "list", "--porcelain"]);
      assert.notInclude(worktrees, created.workspacePath);
    }),
  );

  it.effect("renames the shared branch across all repository worktrees", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeTmpDir();
      yield* makeMultiRepoWorkspace(workspaceRoot);
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const created = yield* workspaceVcs.createWorktreeWorkspace({
        projectCwd: workspaceRoot,
        branch: "t3code/temp-1",
      });

      const renamed = yield* workspaceVcs.renameWorktreeWorkspaceBranchIfPresent({
        path: created.workspacePath,
        oldBranch: "t3code/temp-1",
        newBranch: "t3code/final-name",
      });

      assert.isTrue(renamed);
      for (const repository of created.repositories) {
        assert.equal(
          yield* git(repository.root, ["branch", "--show-current"]),
          "t3code/final-name",
        );
      }

      yield* workspaceVcs.removeWorktreeWorkspaceIfPresent({
        path: created.workspacePath,
      });
    }),
  );

  it.effect("returns false when renaming a non-workspace path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const renamed = yield* workspaceVcs.renameWorktreeWorkspaceBranchIfPresent({
        path: cwd,
        oldBranch: "a",
        newBranch: "b",
      });

      assert.isFalse(renamed);
    }),
  );

  it.effect("returns false when the path is not a worktree workspace", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const workspaceVcs = yield* WorkspaceVcs.WorkspaceVcs;

      const removed = yield* workspaceVcs.removeWorktreeWorkspaceIfPresent({
        path: cwd,
      });

      assert.isFalse(removed);
    }),
  );
});
