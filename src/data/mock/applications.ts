/* =====================================================================
   Seed application data.
   - APPLICATIONS_LIST: the applications-list rows (from applications.html),
     including the lighter Zoopla / OnTheMarket rows that demonstrate
     multi-partner scoping.
   - APPLICATION_RECORDS: richer per-application records (from portal-apps.js)
     used by the detail builder to derive dates, contact details and
     guarantee info deterministically.
   ===================================================================== */
import type { ApplicationSummary, Status } from '../types';

export interface AppRecord {
  ref: string;
  name: string;
  title: string;
  role: string;
  addr1: string;
  postcode: string;
  branch: string;
  agency: string;
  rent: number;
  status: Status;
  date: string;
  referrer: string;
  owner: number;
  // Real tenant/property/timeline values from Supabase, present in live mode only.
  // Mock seed records omit these and the detail builder synthesises deterministic
  // stand-ins instead; their presence is what makes getApplicationDetail show the
  // exact values that were entered, and when each event actually happened.
  dob?: string | null;          // 'YYYY-MM-DD'
  email?: string | null;
  phone?: string | null;
  addr2?: string | null;
  city?: string | null;
  county?: string | null;
  tenancyStartTs?: string | null; // ISO tenancy start
  sentAtTs?: string | null;       // ISO timestamp of the real Sent event
  paidAtTs?: string | null;       // ISO timestamp of the real Paid event
  deedAtTs?: string | null;       // ISO timestamp of the real Deed Issued event
}

/** Rich records (mirror the list, plus role + referrer), used by getApplicationDetail. */
export const APPLICATION_RECORDS: AppRecord[] = [
  { ref: 'GR-20418', name: 'Amelia Hartley', title: 'Ms', role: 'Postgraduate student', addr1: 'Flat 4, 18 Onslow Gardens', postcode: 'SW7 3LA', branch: 'South Kensington', agency: 'Foxglove Residential', rent: 2450, status: 'deed', date: '2026-06-02', referrer: 'Priya Nair', owner: 1 },
  { ref: 'GR-20455', name: 'Chen Wei', title: 'Mr', role: 'Software engineer', addr1: '22 Cale Street', postcode: 'SW3 3QU', branch: 'Chelsea', agency: 'Foxglove Residential', rent: 2200, status: 'paid', date: '2026-06-09', referrer: 'Priya Nair', owner: 1 },
  { ref: 'GR-20489', name: 'Mohammed Al-Rashid', title: 'Mr', role: 'Doctoral researcher', addr1: 'Studio 7, 5 Bina Gardens', postcode: 'SW5 0LA', branch: 'South Kensington', agency: 'Foxglove Residential', rent: 1850, status: 'sent', date: '2026-06-14', referrer: 'Priya Nair', owner: 1 },
  { ref: 'GR-20322', name: 'Sofia Almeida', title: 'Ms', role: 'Marketing manager', addr1: '41 Marylebone High Street', postcode: 'W1U 5HR', branch: 'Marylebone', agency: 'Marylebone & Co', rent: 2800, status: 'deed', date: '2026-05-28', referrer: 'Daniel Wright', owner: 0 },
  { ref: 'GR-20471', name: 'Tariq Hassan', title: 'Mr', role: 'Consultant', addr1: '12 Charlotte Street', postcode: 'W1T 2LP', branch: 'Fitzrovia', agency: 'Marylebone & Co', rent: 2350, status: 'paid', date: '2026-06-11', referrer: 'Aisha Khan', owner: 0 },
  { ref: 'GR-20502', name: 'Grace Okonkwo', title: 'Ms', role: 'Nurse', addr1: '88 Northcote Road', postcode: 'SW11 6QW', branch: 'Clapham', agency: 'Hartwell Estates', rent: 1950, status: 'sent', date: '2026-06-16', referrer: 'Marcus Lin', owner: 0 },
  { ref: 'GR-20288', name: 'Lukas Müller', title: 'Mr', role: 'Product designer', addr1: '30 Rivington Street', postcode: 'EC2A 3DZ', branch: 'Shoreditch', agency: 'Northbank Lettings', rent: 2100, status: 'deed', date: '2026-05-21', referrer: 'Oliver Grant', owner: 0 },
  { ref: 'GR-20466', name: 'Yuki Tanaka', title: 'Ms', role: 'PhD student', addr1: '14 Upper Street', postcode: 'N1 0PQ', branch: 'Islington', agency: 'Northbank Lettings', rent: 1780, status: 'paid', date: '2026-06-12', referrer: 'Oliver Grant', owner: 0 },
  { ref: 'GR-20510', name: 'Isabella Rossi', title: 'Ms', role: 'Architect', addr1: 'Flat 2, 60 Fulham Road', postcode: 'SW3 6HH', branch: 'Chelsea', agency: 'Foxglove Residential', rent: 2650, status: 'sent', date: '2026-06-17', referrer: 'James Okafor', owner: 1 },
  { ref: 'GR-20255', name: 'Daniel Mensah', title: 'Mr', role: 'Secondary teacher', addr1: '5 Bedford Hill', postcode: 'SW12 9RW', branch: 'Balham', agency: 'Hartwell Estates', rent: 1690, status: 'deed', date: '2026-05-19', referrer: 'Marcus Lin', owner: 0 },
  { ref: 'GR-20479', name: 'Priya Raman', title: 'Ms', role: 'Account director', addr1: '9 Goodge Street', postcode: 'W1T 2QJ', branch: 'Fitzrovia', agency: 'Marylebone & Co', rent: 2500, status: 'paid', date: '2026-06-13', referrer: 'Aisha Khan', owner: 0 },
  { ref: 'GR-20518', name: 'Omar Farouk', title: 'Mr', role: 'Postgraduate student', addr1: '77 Old Brompton Road', postcode: 'SW7 3LQ', branch: 'South Kensington', agency: 'Foxglove Residential', rent: 2300, status: 'sent', date: '2026-06-18', referrer: 'Priya Nair', owner: 1 },
  { ref: 'GR-20240', name: 'Hannah Schmidt', title: 'Ms', role: 'Researcher', addr1: '23 Hoxton Square', postcode: 'N1 6NN', branch: 'Shoreditch', agency: 'Northbank Lettings', rent: 2050, status: 'deed', date: '2026-05-16', referrer: 'Oliver Grant', owner: 0 },
  { ref: 'GR-20463', name: 'Carlos Vega', title: 'Mr', role: 'Civil engineer', addr1: "102 St John's Hill", postcode: 'SW11 1SA', branch: 'Clapham', agency: 'Hartwell Estates', rent: 1880, status: 'paid', date: '2026-06-10', referrer: 'Marcus Lin', owner: 0 },
];

/** Agent (branch) office addresses, used on the referring-agent card. */
export const AGENT_ADDR: Record<string, string> = {
  'South Kensington': '42 Old Brompton Road, London, SW7 3DL',
  Chelsea: "118 King's Road, London, SW3 4TR",
  Fulham: '290 Fulham Road, London, SW10 9EW',
  Marylebone: '55 Marylebone High Street, London, W1U 5HS',
  Fitzrovia: '14 Charlotte Street, London, W1T 1RF',
  Clapham: '41 The Pavement, London, SW4 0JA',
  Balham: '9 Hildreth Street, London, SW12 9RQ',
  Shoreditch: '33 Rivington Street, London, EC2A 3QQ',
  Islington: '27 Upper Street, London, N1 0PN',
};

/** Applications-list rows. Rightmove rows first, then lighter Zoopla / OnTheMarket rows. */
export const APPLICATIONS_LIST: ApplicationSummary[] = [
  { ref: 'GR-20418', tenant: 'Amelia Hartley', prop: 'Flat 4, 18 Onslow Gardens, SW7', branch: 'South Kensington', agency: 'Foxglove Residential', ben: 'Onslow Estates Ltd', rent: 2450, status: 'deed', date: '2026-06-02', owner: 1, partner: 'rightmove' },
  { ref: 'GR-20455', tenant: 'Chen Wei', prop: '22 Cale Street, SW3', branch: 'Chelsea', agency: 'Foxglove Residential', ben: 'K&C Property Holdings', rent: 2200, status: 'paid', date: '2026-06-09', owner: 1, partner: 'rightmove' },
  { ref: 'GR-20489', tenant: 'Mohammed Al-Rashid', prop: 'Studio 7, 5 Bina Gardens, SW5', branch: 'South Kensington', agency: 'Foxglove Residential', ben: 'Bina Gardens Mgmt', rent: 1850, status: 'sent', date: '2026-06-14', owner: 1, partner: 'rightmove' },
  { ref: 'GR-20322', tenant: 'Sofia Almeida', prop: '41 Marylebone High Street, W1U', branch: 'Marylebone', agency: 'Marylebone & Co', ben: 'Howard de Walden Est.', rent: 2800, status: 'deed', date: '2026-05-28', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20471', tenant: 'Tariq Hassan', prop: '12 Charlotte Street, W1T', branch: 'Fitzrovia', agency: 'Marylebone & Co', ben: 'Fitzroy Holdings Ltd', rent: 2350, status: 'paid', date: '2026-06-11', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20502', tenant: 'Grace Okonkwo', prop: '88 Northcote Road, SW11', branch: 'Clapham', agency: 'Hartwell Estates', ben: 'Northcote Lettings Ltd', rent: 1950, status: 'sent', date: '2026-06-16', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20288', tenant: 'Lukas Müller', prop: '30 Rivington Street, EC2A', branch: 'Shoreditch', agency: 'Northbank Lettings', ben: 'Rivington Freehold Co', rent: 2100, status: 'deed', date: '2026-05-21', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20466', tenant: 'Yuki Tanaka', prop: '14 Upper Street, N1', branch: 'Islington', agency: 'Northbank Lettings', ben: 'Angel Property Group', rent: 1780, status: 'paid', date: '2026-06-12', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20510', tenant: 'Isabella Rossi', prop: 'Flat 2, 60 Fulham Road, SW3', branch: 'Chelsea', agency: 'Foxglove Residential', ben: 'Fulham Road Estates', rent: 2650, status: 'sent', date: '2026-06-17', owner: 1, partner: 'rightmove' },
  { ref: 'GR-20255', tenant: 'Daniel Mensah', prop: '5 Bedford Hill, SW12', branch: 'Balham', agency: 'Hartwell Estates', ben: 'Bedford Hill Homes Ltd', rent: 1690, status: 'deed', date: '2026-05-19', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20479', tenant: 'Priya Raman', prop: '9 Goodge Street, W1T', branch: 'Fitzrovia', agency: 'Marylebone & Co', ben: 'Goodge Place Estates', rent: 2500, status: 'paid', date: '2026-06-13', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20518', tenant: 'Omar Farouk', prop: '77 Old Brompton Road, SW7', branch: 'South Kensington', agency: 'Foxglove Residential', ben: 'Brompton Cross Ltd', rent: 2300, status: 'sent', date: '2026-06-18', owner: 1, partner: 'rightmove' },
  { ref: 'GR-20240', tenant: 'Hannah Schmidt', prop: '23 Hoxton Square, N1', branch: 'Shoreditch', agency: 'Northbank Lettings', ben: 'Hoxton Square Mgmt', rent: 2050, status: 'deed', date: '2026-05-16', owner: 0, partner: 'rightmove' },
  { ref: 'GR-20463', tenant: 'Carlos Vega', prop: "102 St John's Hill, SW11", branch: 'Clapham', agency: 'Hartwell Estates', ben: "St John's Hill Estates", rent: 1880, status: 'paid', date: '2026-06-10', owner: 0, partner: 'rightmove' },
  { ref: 'GR-21010', tenant: 'Eva Lindqvist', prop: '14 Lavender Hill, SW11', branch: 'Battersea', agency: 'Cityscape Lettings', ben: 'Lavender Estates', rent: 2150, status: 'deed', date: '2026-06-05', owner: 0, partner: 'zoopla' },
  { ref: 'GR-21024', tenant: 'Raj Patel', prop: '9 Mortimer Street, W1W', branch: 'Noho', agency: 'Cityscape Lettings', ben: 'Mortimer Holdings', rent: 2400, status: 'paid', date: '2026-06-12', owner: 0, partner: 'zoopla' },
  { ref: 'GR-21037', tenant: 'Sara Nilsson', prop: '33 Bermondsey Street, SE1', branch: 'Bermondsey', agency: 'Riverside Homes', ben: 'Bermondsey Estates', rent: 1980, status: 'sent', date: '2026-06-19', owner: 0, partner: 'zoopla' },
  { ref: 'GR-22008', tenant: 'Tom Becker', prop: '5 Stoke Newington Rd, N16', branch: 'Stoke Newington', agency: 'Northgate Property', ben: 'Stoke Estates', rent: 1820, status: 'paid', date: '2026-06-08', owner: 0, partner: 'onthemarket' },
  { ref: 'GR-22015', tenant: 'Lucy Chambers', prop: '21 Deptford High St, SE8', branch: 'Deptford', agency: 'Northgate Property', ben: 'Deptford Holdings', rent: 1700, status: 'sent', date: '2026-06-17', owner: 0, partner: 'onthemarket' },
];
