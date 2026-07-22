import { type ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import { useState } from "react";

import { type DraftId } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
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
  const [selectedRepositoryRoot, setSelectedRepositoryRoot] = useState<string | null>(null);
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

  const selectedRepository =
    workspace.repositories.find((repository) => repository.root === selectedRepositoryRoot) ??
    workspace.repositories[0];

  if (!selectedRepository) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={`Choose repository. Current repository: ${selectedRepository.name}`}
              className="max-w-36 min-w-0"
              size="xs"
              variant="outline"
            />
          }
        >
          <FolderGit2Icon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{selectedRepository.name}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {workspace.repositories.map((repository) => (
            <MenuItem
              key={repository.root}
              onClick={() => setSelectedRepositoryRoot(repository.root)}
            >
              <FolderGit2Icon aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={repository.name}>
                {repository.name}
              </span>
              {repository.root === selectedRepository.root && (
                <CheckIcon aria-hidden="true" className="text-foreground" />
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <GitActionsControl
        gitCwd={selectedRepository.root}
        activeThreadRef={activeThreadRef}
        {...(draftId ? { draftId } : {})}
        syncThreadBranch={false}
      />
    </div>
  );
}
