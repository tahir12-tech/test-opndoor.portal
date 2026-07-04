/* =====================================================================
   Sidebar — brand, product label, role-filtered navigation, and the
   signed-in user footer. Ported from portal.js buildSidebar. The
   reconciliation badge count comes from the queue.
   ===================================================================== */
import { Link, useNavigate } from 'react-router-dom';
import { reconciliationPendingCount } from '@/data';
import { useSession } from '@/session/SessionContext';
import { SUPABASE_ENABLED } from '@/lib/supabase';
import { NAV } from '@/constants/nav';
import { usePageMetaValue } from './pageMeta';
import { Icon } from '@/components/ui/Icon';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  // useSession() re-renders on dataVersion bumps (re-hydration), so the badge
  // reflects the current pending-review count after a confirm or a new referral.
  const { role, user, signOut } = useSession();
  const navigate = useNavigate();
  const { active } = usePageMetaValue();
  const reconcileBadge = reconciliationPendingCount();

  return (
    <>
      <div className="sb__brand">
        <span className="wordmark">opndoor</span>
        <span className="sb__cobrand">
          Partner<br />portal
        </span>
      </div>
      <div className="sb__product">
        <div className="sb__product-tag">Guarantee</div>
        <div className="sb__product-name">Referral Portal</div>
      </div>

      <nav className="sb__nav">
        {NAV.map((grp) => {
          const items = grp.items.filter((it) => it.roles.includes(role));
          if (!items.length) return null;
          return (
            <div className="sb__group" key={grp.group}>
              <div className="sb__group-label">{grp.group}</div>
              {items.map((it) => {
                const badge = it.badge === 'reconcile' ? reconcileBadge : undefined;
                return (
                  <Link key={it.id} className={`sb__link${active === it.id ? ' is-active' : ''}`} to={it.to} onClick={onNavigate}>
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {badge ? <span className="sb__link-badge">{badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="sb__foot">
        <div className="sb__user">
          <span className="sb__avatar">{user.initials}</span>
          <div>
            <div className="sb__user-name">{user.name}</div>
            <div className="sb__user-role">{user.label}</div>
          </div>
          {SUPABASE_ENABLED && (
            <button
              type="button"
              className="iconbtn"
              aria-label="Sign out"
              title="Sign out"
              style={{ marginLeft: 'auto' }}
              onClick={async () => { await signOut(); navigate('/login'); }}
            >
              <Icon name="arrowLeft" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
