import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

/** Switch machines only within the selected logical project. */
export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
  settings: ProjectGroupingSettings = {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  },
): EnvironmentProject | null {
  if (selectedProject === null) return projectsOnTarget[0] ?? null;
  const key = deriveLogicalProjectKeyFromSettings(selectedProject, settings);
  return (
    projectsOnTarget.find(
      (project) => deriveLogicalProjectKeyFromSettings(project, settings) === key,
    ) ?? null
  );
}

/** Keep a queued task's host available even before its project shell loads. */
export function resolveNewTaskEnvironments(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProject: EnvironmentProject | null;
  readonly settings: ProjectGroupingSettings;
  readonly savedConnectionsById: Readonly<
    Record<string, { readonly environmentLabel: string } | undefined>
  >;
  readonly pendingTaskEnvironmentId: EnvironmentId | null;
}): Array<{ readonly environmentId: EnvironmentId; readonly environmentLabel: string }> {
  const selectedKey = input.selectedProject
    ? deriveLogicalProjectKeyFromSettings(input.selectedProject, input.settings)
    : null;
  const candidates = input.projects
    .filter(
      (project) =>
        selectedKey === null ||
        deriveLogicalProjectKeyFromSettings(project, input.settings) === selectedKey,
    )
    .map((project) => project.environmentId);
  if (input.pendingTaskEnvironmentId !== null) {
    candidates.unshift(input.pendingTaskEnvironmentId);
  }
  return [...new Set(candidates)].flatMap((environmentId) => {
    const environment = input.savedConnectionsById[environmentId];
    return environment ? [{ environmentId, environmentLabel: environment.environmentLabel }] : [];
  });
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}

export function newTaskDestination(
  _usesSplitView: boolean,
  projects: ReadonlyArray<EnvironmentProject>,
  currentProject: Pick<EnvironmentProject, "environmentId" | "id"> | undefined,
  requestId: string,
) {
  const project =
    projects.find(
      (candidate) =>
        candidate.environmentId === currentProject?.environmentId &&
        candidate.id === currentProject.id,
    ) ?? projects[0];
  return project
    ? {
        draft: {
          requestId,
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        },
      }
    : { draft: { requestId } };
}
