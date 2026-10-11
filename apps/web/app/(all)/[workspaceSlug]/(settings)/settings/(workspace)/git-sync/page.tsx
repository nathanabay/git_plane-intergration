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
  
  // EUserPermissions.ADMIN value is 20 - verified in Plane source
  const canPerformWorkspaceAdminActions = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);

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

  if (!canPerformWorkspaceAdminActions) {
    return <NotAuthorizedView section="settings" className="h-auto" />;
  }

  // Server-side enforcement of writes belongs to the config API (B3), not here.
  return (
    <SettingsContentWrapper>
      <PageHead title="GitHub Sync" />
      <div className="h-full w-full">
        <iframe
          src={`/git-sync/ui/workspaces/${workspaceSlug}`}
          className="h-full w-full border-none"
          title="GitHub Sync Workspace Configuration"
        />
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(GitSyncWorkspacePage);
