/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
// plane internal packages
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
// hooks
import { useTheme } from "@/hooks/store";
import { useSidebarMenu } from "@/hooks/use-sidebar-menu";

export const AdminSidebarMenu = observer(function AdminSidebarMenu() {
  // router
  const pathName = usePathname();
  // store hooks
  const { isSidebarCollapsed, toggleSidebar } = useTheme();
  // derived values
  const sidebarMenu = useSidebarMenu();

  const gitSyncItem = {
    Icon: () => (
      <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
        <path d="M9 18c-4.51 2-5-2-7-2" />
      </svg>
    ),
    name: "GitHub Sync",
    description: "Manage GitHub synchronization.",
    href: "/git-sync/",
  };

  const allMenus = [...sidebarMenu, gitSyncItem];

  const handleItemClick = () => {
    if (window.innerWidth < 768) {
      toggleSidebar(!isSidebarCollapsed);
    }
  };

  return (
    <div className="vertical-scrollbar flex scrollbar-sm h-full w-full flex-col gap-2.5 overflow-y-scroll px-4 py-4">
      {allMenus.map((item) => {
        const isActive = item.href === pathName || pathName?.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} onClick={handleItemClick}>
            <div>
              <Tooltip tooltipContent={item.name} position="right" className="ml-2" disabled={!isSidebarCollapsed}>
                <div
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-md px-3 py-2 transition-colors outline-none",
                    {
                      "!bg-layer-transparent-active text-primary": isActive,
                      "text-secondary hover:bg-layer-transparent-hover active:bg-layer-transparent-active": !isActive,
                    },
                    isSidebarCollapsed ? "justify-center" : "w-[260px]"
                  )}
                >
                  {<item.Icon className="h-4 w-4 flex-shrink-0" />}
                  {!isSidebarCollapsed && (
                    <div className="w-full">
                      <div className={cn(`text-body-xs-medium transition-colors`)}>{item.name}</div>
                      <div className={cn(`text-caption-sm-regular transition-colors`)}>{item.description}</div>
                    </div>
                  )}
                </div>
              </Tooltip>
            </div>
          </Link>
        );
      })}
    </div>
  );
});
