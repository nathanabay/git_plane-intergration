import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { LogoSpinner } from "@/components/common/logo-spinner";
import { useUserPermissions } from "@/hooks/store/user";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { PageHead } from "@/components/core/page-title";
import type { Route } from "./+types/page";

function GitSyncWorkspacePage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { workspaceUserInfo, allowPermissions } = useUserPermissions();
  
  // EUserPermissions.ADMIN value is 20, MEMBER 15 - verified in Plane source
  const canPerformWorkspaceAdminActions = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const isWorkspaceMember = allowPermissions([EUserPermissions.MEMBER], EUserPermissionsLevel.WORKSPACE);

  if (!workspaceUserInfo) {
    return (
      <SettingsContentWrapper>
        <PageHead title="GitHub Sync" />
        <div className="grid size-full place-items-center px-4">
          <LogoSpinner />
        </div>
      </SettingsContentWrapper>
    );
  }

  if (!canPerformWorkspaceAdminActions && !isWorkspaceMember) {
    return <NotAuthorizedView section="settings" className="h-auto" />;
  }

  // Server-side enforcement of writes belongs to the config API (B3), not here.
  return (
    <SettingsContentWrapper>
      <PageHead title="GitHub Sync" />
      <div className="h-full w-full">
        <iframe
          // Members see only their own GitHub account link; the workspace connection stays admin-only.
          src={`/git-sync/ui/workspaces/${workspaceSlug}${canPerformWorkspaceAdminActions ? "" : "/account"}`}
          className="w-full border-none"
          // h-full collapses here: the settings container has no fixed height, so fill the viewport.
          style={{ height: "calc(100vh - 8rem)" }}
          title="GitHub Sync Workspace Configuration"
        />
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(GitSyncWorkspacePage);
