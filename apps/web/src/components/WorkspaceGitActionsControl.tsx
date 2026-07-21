import { type ScopedThreadRef } from "@t3tools/contracts";

import { type DraftId } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import GitActionsControl from "./GitActionsControl";

interface WorkspaceGitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
}

/**
 * Renders git actions for the active working directory. For a single
 * repository this is a plain {@link GitActionsControl}. For a multi-repo
 * workspace folder (or a worktree workspace mirroring one) it renders one
 * labeled control per discovered child repository.
 */
export default function WorkspaceGitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
}: WorkspaceGitActionsControlProps) {
  const environmentId = activeThreadRef?.environmentId ?? null;
  const repositoriesQuery = useEnvironmentQuery(
    environmentId !== null && gitCwd !== null
      ? vcsEnvironment.listRepositories({
          environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const workspace = repositoriesQuery.data;

  if (workspace?.kind !== "workspace") {
    return (
      <GitActionsControl
        gitCwd={gitCwd}
        activeThreadRef={activeThreadRef}
        {...(draftId ? { draftId } : {})}
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {workspace.repositories.map((repository) => (
        <div key={repository.root} className="flex min-w-0 items-center gap-1">
          <span className="max-w-24 truncate text-xs text-muted-foreground" title={repository.name}>
            {repository.name}
          </span>
          <GitActionsControl
            gitCwd={repository.root}
            activeThreadRef={activeThreadRef}
            {...(draftId ? { draftId } : {})}
            syncThreadBranch={false}
          />
        </div>
      ))}
    </div>
  );
}
