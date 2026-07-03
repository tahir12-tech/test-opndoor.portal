/* Regression guard for the GR-20608 data-integrity bug: a Supabase-hydrated
   record must render the exact values that were entered, and the real time each
   event happened, with no seed-generator synthesis (no first.last@gmail.com,
   no +44 7700 900xx phone, no fixed 10:24 / 16:09 times, no default DOB).
   Run with `npm run smoke`. */
import { describe, expect, it } from 'vitest';
import { getApplicationDetail, hydrateApplications } from '@/data';
import type { AppRecord } from '@/data/mock/applications';

// Round-trip real timestamps through the same instant the code sees, so the
// assertions hold regardless of the machine's timezone.
const sent = new Date(2026, 6, 3, 10, 4, 0); // 03 Jul 2026, 10:04 local
const paid = new Date(2026, 6, 3, 10, 7, 0); // 03 Jul 2026, 10:07 local
const tenancy = new Date(2026, 10, 10, 0, 0, 0); // 10 Nov 2026

const REAL: AppRecord = {
  ref: 'GR-20608',
  name: 'Matthew Dwyer',
  title: 'Dr',
  role: '',
  addr1: '12 Example Street',
  postcode: 'SW1A 1AA',
  branch: 'Test Branch',
  agency: 'Test Agency',
  rent: 1000,
  status: 'paid',
  date: '2026-07-03',
  referrer: 'A Referrer',
  owner: 0,
  dob: '1997-11-20',
  email: 'mdwyer@opndoor.co',
  phone: '07950446107',
  addr2: 'Flat 2',
  city: 'London',
  county: 'Merseyside',
  tenancyStartTs: tenancy.toISOString(),
  sentAtTs: sent.toISOString(),
  paidAtTs: paid.toISOString(),
  deedAtTs: null,
};

describe('getApplicationDetail shows real values, never synthesised ones', () => {
  hydrateApplications([], [REAL]);
  const d = getApplicationDetail('GR-20608');

  it('uses the exact typed contact details', () => {
    expect(d.email).toBe('mdwyer@opndoor.co');
    expect(d.phone).toBe('07950446107');
    // and specifically NOT the seed-generator fingerprints
    expect(d.email.endsWith('@gmail.com')).toBe(false);
    expect(d.phone.startsWith('+44 7700 900')).toBe(false);
  });

  it('uses the exact typed date of birth (birthday-aware age)', () => {
    expect(d.dob).toBe('20 November 1997 (28)');
  });

  it('uses the real property address, city and county', () => {
    expect(d.addr2).toBe('Flat 2');
    expect(d.city).toBe('London');
    expect(d.county).toBe('Merseyside'); // not the synthetic 'Greater London'
  });

  it('uses the real tenancy start date', () => {
    expect(d.tenancyStart).toBe('10 November 2026');
  });

  it('shows the real date and time each event happened', () => {
    expect(d.sentStr).toBe('03 Jul 2026 · 10:04');
    expect(d.paidStr).toBe('03 Jul 2026 · 10:07');
    // not the seed-generator fixed times
    expect(d.sentStr?.endsWith('10:24')).toBe(false);
    expect(d.paidStr?.endsWith('16:09')).toBe(false);
  });
});
