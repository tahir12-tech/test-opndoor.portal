/* Guards for the batch fixes:
   - Item 8: an unknown/inaccessible reference yields an honest not-found detail,
     never a substituted record.
   - Item 9: 'Refunded' is a status chip that cross-cuts Paid; counts stay honest
     (All = Sent + Paid + Deed; Refunded counted separately). */
import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_PARTNERS, countByStatus, getApplications, getApplicationDetail, hydrateApplications, referrerNamesForScope } from '@/data';
import type { ApplicationSummary } from '@/data';
import type { AppRecord } from '@/data/mock/applications';

function sum(ref: string, status: ApplicationSummary['status'], refunded = false): ApplicationSummary {
  return { ref, tenant: `T ${ref}`, prop: '1 St', branch: 'B', agency: 'A', ben: '', rent: 1000, status, date: '2026-06-01', owner: 1, partner: 'rightmove', refunded };
}
function rec(ref: string): AppRecord {
  return { ref, name: `T ${ref}`, title: 'Mr', role: '', addr1: '1 St', postcode: 'SW1', branch: 'B', agency: 'A', rent: 1000, status: 'paid', date: '2026-06-01', referrer: 'R', owner: 1 };
}

const LIST: ApplicationSummary[] = [
  sum('GR-1', 'sent'), sum('GR-2', 'paid'), sum('GR-3', 'paid', true),
  sum('GR-4', 'deed'), sum('GR-5', 'paid', true),
];
const opts = { role: 'superadmin' as const, scope: ALL_PARTNERS };

describe('countByStatus + refunded chip (item 9)', () => {
  beforeEach(() => hydrateApplications(LIST, []));

  it('counts respect partner, agency, branch and referrer filters', () => {
    const rows: ApplicationSummary[] = [
      { ref: 'GR-10', tenant: 'T GR-10', prop: '1 St', branch: 'B', agency: 'A', ben: '', rent: 1000, status: 'sent', date: '2026-06-01', owner: 1, partner: 'rightmove', referrer: 'Alice' },
      { ref: 'GR-11', tenant: 'T GR-11', prop: '1 St', branch: 'B', agency: 'A', ben: '', rent: 1000, status: 'paid', date: '2026-06-01', owner: 1, partner: 'rightmove', referrer: null },
      { ref: 'GR-12', tenant: 'T GR-12', prop: '1 St', branch: 'B', agency: 'A', ben: '', rent: 1000, status: 'deed', date: '2026-06-01', owner: 1, partner: 'rightmove', referrer: 'Alice' },
      { ref: 'GR-13', tenant: 'T GR-13', prop: '1 St', branch: 'B2', agency: 'A2', ben: '', rent: 1000, status: 'paid', date: '2026-06-01', owner: 1, partner: 'other', referrer: 'Alice' },
    ];
    hydrateApplications(rows, []);

    const c = countByStatus({ ...opts, partner: 'rightmove', agency: 'A', branch: 'B', referrer: 'Alice' } as any);
    expect(c).toMatchObject({ all: 1, sent: 1, paid: 0, deed: 0, refunded: 0 });
  });

  it('counts refunded separately and keeps All = Sent + Paid + Deed', () => {
    const c = countByStatus(opts);
    expect(c).toMatchObject({ all: 5, sent: 1, paid: 3, deed: 1, refunded: 2 });
    expect(c.sent + c.paid + c.deed).toBe(c.all); // refunded is a cross-cut, not additive
  });

  it('the Refunded filter returns only refunded rows (all still Paid by status)', () => {
    const rows = getApplications({ ...opts, status: 'refunded' });
    expect(rows.map((r) => r.ref).sort()).toEqual(['GR-3', 'GR-5']);
    expect(rows.every((r) => r.refunded && r.status === 'paid')).toBe(true);
  });

  it('the Paid filter still includes refunded rows (status is Paid)', () => {
    expect(getApplications({ ...opts, status: 'paid' })).toHaveLength(3);
  });
});

describe('referrer filter + period recount (owner addition)', () => {
  const T = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  function sumRP(ref: string, status: ApplicationSummary['status'], referrer: string | null, sentAtTs?: number, date = '2026-06-01'): ApplicationSummary {
    return { ref, tenant: `T ${ref}`, prop: '1 St', branch: 'B', agency: 'A', ben: '', rent: 1000, status, date, owner: 1, partner: 'rightmove', referrer, sentAtTs };
  }
  const ROWS: ApplicationSummary[] = [
    sumRP('GR-A', 'sent', 'Alice', T(2026, 6, 10)),
    sumRP('GR-B', 'paid', 'Alice', T(2026, 5, 15)),   // May — out of a June window
    sumRP('GR-C', 'deed', 'Bob', T(2026, 6, 20)),
    sumRP('GR-D', 'paid', null, undefined, '2026-06-01'), // no sentAtTs -> falls back to `date`
  ];
  const june: [Date, Date] = [new Date(2026, 5, 1, 0, 0, 0, 0), new Date(2026, 5, 30, 23, 59, 59, 999)];
  beforeEach(() => hydrateApplications(ROWS, []));

  it('referrerNamesForScope lists distinct referrers, sorted, excluding unknowns', () => {
    expect(referrerNamesForScope(opts)).toEqual(['Alice', 'Bob']); // null referrer omitted
  });

  it('the referrer filter returns only that referrer\'s rows', () => {
    expect(getApplications({ ...opts, referrer: 'Alice' }).map((r) => r.ref).sort()).toEqual(['GR-A', 'GR-B']);
  });

  it('the period filter buckets on sent date, falling back to `date` when unset', () => {
    const rows = getApplications({ ...opts, periodRange: june }).map((r) => r.ref).sort();
    expect(rows).toEqual(['GR-A', 'GR-C', 'GR-D']); // GR-B (May) excluded; GR-D via date fallback
  });

  it('status chips recount within the selected period', () => {
    const c = countByStatus({ ...opts, periodRange: june });
    expect(c).toMatchObject({ all: 3, sent: 1, paid: 1, deed: 1 }); // GR-B dropped from the May bucket
  });

  it('referrer and period compose (Alice, in June = GR-A only)', () => {
    expect(getApplications({ ...opts, referrer: 'Alice', periodRange: june }).map((r) => r.ref)).toEqual(['GR-A']);
  });
});

describe('getApplicationDetail honest not-found (item 8)', () => {
  beforeEach(() => hydrateApplications([], [rec('GR-100')]));

  it('flags an unknown reference as not-found without substituting another record', () => {
    const d = getApplicationDetail('GR-999');
    expect(d.notFound).toBe(true);
    expect(d.ref).toBe('GR-999');      // echoes the requested ref, not GR-100
    expect(d.name).toBe('');           // no leaked tenant
  });

  it('returns the real record when the reference exists', () => {
    const d = getApplicationDetail('GR-100');
    expect(d.notFound).toBeFalsy();
    expect(d.ref).toBe('GR-100');
  });

  it('treats a null reference as not-found', () => {
    expect(getApplicationDetail(null).notFound).toBe(true);
  });
});
