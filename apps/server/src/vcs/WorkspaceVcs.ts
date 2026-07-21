import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  type VcsListRepositoriesInput,
  type VcsListRepositoriesResult,
  type VcsWorkspaceRepository,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

export const WORKTREE_WORKSPACE_MANIFEST_FILENAME = ".t3-worktree-workspace.json";

const IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);

const WorktreeWorkspaceManifest = Schema.Struct({
  version: Schema.Literal(1),
  projectCwd: Schema.String,
  branch: Schema.String,
  repositories: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      root: Schema.String,
    }),
  ),
});
type WorktreeWorkspaceManifest = typeof WorktreeWorkspaceManifest.Type;

const WorktreeWorkspaceManifestJson = Schema.fromJsonString(WorktreeWorkspaceManifest);
const decodeManifest = Schema.decodeUnknownEffect(WorktreeWorkspaceManifestJson);
const encodeManifest = Schema.encodeEffect(WorktreeWorkspaceManifestJson);

export interface CreateWorktreeWorkspaceInput {
  readonly projectCwd: string;
  readonly branch: string;
}

export interface CreateWorktreeWorkspaceResult {
  readonly workspacePath: string;
  readonly branch: string;
  readonly repositories: ReadonlyArray<VcsWorkspaceRepository>;
}

/**
 * Multi-repo workspace support: discovers the git repositories contained in a
 * project workspace root and manages "worktree workspaces" — a directory that
 * mirrors a multi-repo workspace with one worktree per child repository, all
 * on the same branch name.
 */
export class WorkspaceVcs extends Context.Service<
  WorkspaceVcs,
  {
    readonly listRepositories: (
      input: VcsListRepositoriesInput,
    ) => Effect.Effect<VcsListRepositoriesResult, GitCommandError>;
    readonly createWorktreeWorkspace: (
      input: CreateWorktreeWorkspaceInput,
    ) => Effect.Effect<CreateWorktreeWorkspaceResult, GitCommandError>;
    /**
     * Removes a worktree workspace previously created by
     * `createWorktreeWorkspace`. Returns `false` when the path is not a
     * worktree workspace so callers can fall back to single-repo removal.
     */
    readonly removeWorktreeWorkspaceIfPresent: (input: {
      readonly path: string;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<boolean, GitCommandError>;
    /**
     * Renames the shared branch of a worktree workspace in every child
     * repository. Returns `false` when the path is not a worktree workspace
     * so callers can fall back to single-repo branch renaming.
     */
    readonly renameWorktreeWorkspaceBranchIfPresent: (input: {
      readonly path: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<boolean, GitCommandError>;
  }
>()("t3/vcs/WorkspaceVcs") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const { worktreesDir } = yield* ServerConfig;

  const isGitRepositoryRoot = (candidate: string) =>
    fs.exists(path.join(candidate, ".git")).pipe(Effect.orElseSucceed(() => false));

  const listRepositories: WorkspaceVcs["Service"]["listRepositories"] = Effect.fn(
    "WorkspaceVcs.listRepositories",
  )(function* (input) {
    const cwd = input.cwd;
    if (yield* isGitRepositoryRoot(cwd)) {
      return {
        kind: "repository" as const,
        repositories: [
          {
            name: path.basename(cwd),
            root: cwd,
            relativePath: "",
          },
        ],
      };
    }

    const entries = yield* fs.readDirectory(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "WorkspaceVcs.listRepositories",
            command: "read-directory",
            cwd,
            detail: "Failed to read the workspace directory while discovering repositories.",
            cause,
          }),
      ),
    );

    const repositories: Array<VcsWorkspaceRepository> = [];
    for (const entry of entries) {
      if (entry.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry)) {
        continue;
      }
      const candidate = path.join(cwd, entry);
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (info._tag !== "Some" || info.value.type !== "Directory") {
        continue;
      }
      if (yield* isGitRepositoryRoot(candidate)) {
        repositories.push({
          name: entry,
          root: candidate,
          relativePath: entry,
        });
      }
    }
    repositories.sort((left, right) => left.name.localeCompare(right.name));

    return {
      kind: repositories.length > 0 ? ("workspace" as const) : ("none" as const),
      repositories,
    };
  });

  const removeRepositoryWorktreeBestEffort = Effect.fn(
    "WorkspaceVcs.removeRepositoryWorktreeBestEffort",
  )(function* (input: { readonly repoRoot: string; readonly worktreePath: string }) {
    yield* git
      .removeWorktree({
        cwd: input.repoRoot,
        path: input.worktreePath,
        force: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to remove a repository worktree from a worktree workspace.", {
            repoRoot: input.repoRoot,
            worktreePath: input.worktreePath,
            detail: error.detail,
          }),
        ),
      );
  });

  const createWorktreeWorkspace: WorkspaceVcs["Service"]["createWorktreeWorkspace"] = Effect.fn(
    "WorkspaceVcs.createWorktreeWorkspace",
  )(function* (input) {
    const listed = yield* listRepositories({ cwd: input.projectCwd });
    if (listed.kind !== "workspace") {
      return yield* new GitCommandError({
        operation: "WorkspaceVcs.createWorktreeWorkspace",
        command: "worktree-workspace-create",
        cwd: input.projectCwd,
        detail:
          listed.kind === "repository"
            ? "The workspace root is a single git repository; use a regular worktree instead."
            : "No git repositories were found in the workspace root.",
      });
    }

    const sanitizedBranch = input.branch.replace(/\//g, "-");
    const workspacePath = path.join(worktreesDir, path.basename(input.projectCwd), sanitizedBranch);

    yield* fs.makeDirectory(workspacePath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "WorkspaceVcs.createWorktreeWorkspace",
            command: "make-directory",
            cwd: input.projectCwd,
            detail: `Failed to create the worktree workspace directory at ${workspacePath}.`,
            cause,
          }),
      ),
    );

    const created: Array<{
      readonly repoRoot: string;
      readonly worktreePath: string;
    }> = [];
    const cleanupCreatedWorktrees = Effect.forEach(
      created,
      (entry) => removeRepositoryWorktreeBestEffort(entry),
      { discard: true },
    ).pipe(Effect.andThen(fs.remove(workspacePath, { recursive: true }).pipe(Effect.ignore)));

    yield* Effect.gen(function* () {
      for (const repository of listed.repositories) {
        const worktreePath = path.join(workspacePath, repository.name);
        yield* git.createWorktree({
          cwd: repository.root,
          refName: "HEAD",
          newRefName: input.branch,
          path: worktreePath,
        });
        created.push({ repoRoot: repository.root, worktreePath });
      }

      const manifest: WorktreeWorkspaceManifest = {
        version: 1,
        projectCwd: input.projectCwd,
        branch: input.branch,
        repositories: listed.repositories.map((repository) => ({
          name: repository.name,
          root: repository.root,
        })),
      };
      const manifestJson = yield* encodeManifest(manifest).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "WorkspaceVcs.createWorktreeWorkspace",
              command: "write-manifest",
              cwd: input.projectCwd,
              detail: "Failed to encode the worktree workspace manifest.",
              cause,
            }),
        ),
      );
      yield* fs
        .writeFileString(
          path.join(workspacePath, WORKTREE_WORKSPACE_MANIFEST_FILENAME),
          manifestJson,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "WorkspaceVcs.createWorktreeWorkspace",
                command: "write-manifest",
                cwd: input.projectCwd,
                detail: "Failed to write the worktree workspace manifest.",
                cause,
              }),
          ),
        );
    }).pipe(Effect.onError(() => cleanupCreatedWorktrees));

    return {
      workspacePath,
      branch: input.branch,
      repositories: listed.repositories.map((repository) => ({
        name: repository.name,
        root: path.join(workspacePath, repository.name),
        relativePath: repository.name,
      })),
    };
  });

  const readManifestIfPresent = Effect.fn("WorkspaceVcs.readManifestIfPresent")(function* (
    workspacePath: string,
  ) {
    const manifestPath = path.join(workspacePath, WORKTREE_WORKSPACE_MANIFEST_FILENAME);
    const manifestExists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!manifestExists) {
      return null;
    }
    return yield* fs.readFileString(manifestPath).pipe(
      Effect.flatMap((contents) => decodeManifest(contents)),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "WorkspaceVcs.readManifestIfPresent",
            command: "read-manifest",
            cwd: workspacePath,
            detail: "Failed to read the worktree workspace manifest.",
            cause,
          }),
      ),
    );
  });

  const removeWorktreeWorkspaceIfPresent: WorkspaceVcs["Service"]["removeWorktreeWorkspaceIfPresent"] =
    Effect.fn("WorkspaceVcs.removeWorktreeWorkspaceIfPresent")(function* (input) {
      const manifest = yield* readManifestIfPresent(input.path);
      if (manifest === null) {
        return false;
      }

      yield* Effect.forEach(
        manifest.repositories,
        (repository) =>
          removeRepositoryWorktreeBestEffort({
            repoRoot: repository.root,
            worktreePath: path.join(input.path, repository.name),
          }),
        { discard: true },
      );

      yield* fs.remove(input.path, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "WorkspaceVcs.removeWorktreeWorkspaceIfPresent",
              command: "remove-directory",
              cwd: input.path,
              detail: "Failed to remove the worktree workspace directory.",
              cause,
            }),
        ),
      );

      return true;
    });

  const renameWorktreeWorkspaceBranchIfPresent: WorkspaceVcs["Service"]["renameWorktreeWorkspaceBranchIfPresent"] =
    Effect.fn("WorkspaceVcs.renameWorktreeWorkspaceBranchIfPresent")(function* (input) {
      const manifest = yield* readManifestIfPresent(input.path);
      if (manifest === null) {
        return false;
      }

      for (const repository of manifest.repositories) {
        yield* git.renameBranch({
          cwd: path.join(input.path, repository.name),
          oldBranch: input.oldBranch,
          newBranch: input.newBranch,
        });
      }

      const updatedManifest: WorktreeWorkspaceManifest = {
        ...manifest,
        branch: input.newBranch,
      };
      const manifestJson = yield* encodeManifest(updatedManifest).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "WorkspaceVcs.renameWorktreeWorkspaceBranchIfPresent",
              command: "write-manifest",
              cwd: input.path,
              detail: "Failed to encode the worktree workspace manifest.",
              cause,
            }),
        ),
      );
      yield* fs
        .writeFileString(path.join(input.path, WORKTREE_WORKSPACE_MANIFEST_FILENAME), manifestJson)
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "WorkspaceVcs.renameWorktreeWorkspaceBranchIfPresent",
                command: "write-manifest",
                cwd: input.path,
                detail: "Failed to update the worktree workspace manifest.",
                cause,
              }),
          ),
        );

      return true;
    });

  return WorkspaceVcs.of({
    listRepositories,
    createWorktreeWorkspace,
    removeWorktreeWorkspaceIfPresent,
    renameWorktreeWorkspaceBranchIfPresent,
  });
});

export const layer = Layer.effect(WorkspaceVcs, make);
