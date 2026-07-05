/* =====================================================================
   Sidebar navigation model (ported from portal.js NAV).
   Each item declares the roles allowed to see it; the sidebar filters by
   the active role. Routes replace the prototype's .html hrefs.
   ===================================================================== */
import type { Role } from '@/data';
import type { IconName } from '@/components/ui/Icon';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: IconName;
  roles: Role[];
  /** Set on the reconciliation item; the sidebar fills the count from the queue. */
  badge?: 'reconcile';
}

export interface NavGroup {
  group: string;
  adminGroup?: boolean;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    group: 'Tracking',
    items: [
      { id: 'dashboard', label: 'Dashboard', to: '/dashboard', icon: 'dashboard', roles: ['superadmin', 'management', 'referrer'] },
      { id: 'applications', label: 'Applications', to: '/applications', icon: 'apps', roles: ['superadmin', 'management', 'referrer'] },
      { id: 'league', label: 'League', to: '/league', icon: 'trend', roles: ['superadmin', 'management', 'referrer'] },
      { id: 'new', label: 'New application', to: '/new-application', icon: 'plus', roles: ['superadmin', 'management', 'referrer'] },
    ],
  },
  {
    group: 'Organisation',
    items: [{ id: 'org', label: 'Agencies & branches', to: '/agencies', icon: 'org', roles: ['superadmin', 'management', 'referrer'] }],
  },
  {
    group: 'Administration',
    adminGroup: true,
    items: [
      { id: 'partners', label: 'Partners', to: '/partners', icon: 'partners', roles: ['superadmin'] },
      { id: 'users', label: 'Users', to: '/users', icon: 'users', roles: ['management'] },
    ],
  },
  {
    group: 'opndoor',
    adminGroup: true,
    items: [
      { id: 'opteam', label: 'opndoor team', to: '/users?team=opndoor', icon: 'users', roles: ['superadmin'] },
      { id: 'reconcile', label: 'Reconciliation', to: '/reconciliation', icon: 'reconcile', roles: ['superadmin'], badge: 'reconcile' },
      { id: 'health', label: 'Health', to: '/health', icon: 'shield', roles: ['superadmin'] },
    ],
  },
];
