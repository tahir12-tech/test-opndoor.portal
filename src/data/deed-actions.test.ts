/* Per-role gating of the two deed actions on an awaiting-signature deed.
   - "Resend signature request" (tenant nudge): owning Referrer, Management, admin.
   - "Replace and resend deed" (void + reissue): Management and opndoor admin only.
   Run with `npm run smoke`. */
import { describe, expect, it } from 'vitest';
import { canAmendTenancyStart, canReplaceDeed, canSendDeed } from '@/data';
import type { Role } from '@/data/types';

const ROLES: Role[] = ['referrer', 'management', 'superadmin'];

describe('Replace and resend deed (canReplaceDeed)', () => {
  it('is Management and opndoor admin only, never a Referrer', () => {
    expect(canReplaceDeed('referrer')).toBe(false);
    expect(canReplaceDeed('management')).toBe(true);
    expect(canReplaceDeed('superadmin')).toBe(true);
  });
});

describe('Resend signature request audience (canSendDeed proxy: owning Referrer / Management / admin)', () => {
  it('every authorised viewer of their own awaiting deed qualifies', () => {
    // A Referrer viewing their OWN application qualifies; Management/admin always do.
    for (const role of ROLES) expect(canSendDeed(role, true)).toBe(true);
  });
  it('a Referrer never qualifies on an application they do not own', () => {
    expect(canSendDeed('referrer', false)).toBe(false);
    // Management and admin still qualify regardless of ownership.
    expect(canSendDeed('management', false)).toBe(true);
    expect(canSendDeed('superadmin', false)).toBe(true);
  });
});

describe('Amend boundary (canAmendTenancyStart) is deed-state aware', () => {
  it('owning Referrer may amend while Sent or Paid-but-unexecuted', () => {
    expect(canAmendTenancyStart('referrer', 'sent', true)).toBe(true);
    expect(canAmendTenancyStart('referrer', 'paid', true, 'awaiting_tenant')).toBe(true);
    expect(canAmendTenancyStart('referrer', 'paid', true, 'error')).toBe(true);
    expect(canAmendTenancyStart('referrer', 'paid', true, null)).toBe(true);
  });
  it('a Referrer cannot amend one they do not own', () => {
    expect(canAmendTenancyStart('referrer', 'sent', false)).toBe(false);
    expect(canAmendTenancyStart('referrer', 'paid', false, 'awaiting_tenant')).toBe(false);
  });
  it('executed deeds are Management / opndoor admin only', () => {
    expect(canAmendTenancyStart('referrer', 'paid', true, 'executed')).toBe(false);
    expect(canAmendTenancyStart('referrer', 'deed', true, 'executed')).toBe(false);
    expect(canAmendTenancyStart('management', 'deed', false, 'executed')).toBe(true);
    expect(canAmendTenancyStart('superadmin', 'paid', false, 'executed')).toBe(true);
  });
});
