/* =====================================================================
   Data / service layer — the single seam between the UI and the back end.
   Screens import ONLY from here (`import { getApplications } from '@/data'`).
   No screen touches localStorage or a mock array directly. To wire a real
   back end, replace the bodies of these services with fetch() calls; the
   screens do not change.
   ===================================================================== */
export * from './types';

export * as authService from './authService';
export * from './partnersService';
export * from './orgService';
export * from './applicationsService';
export * from './analyticsService';
export * from './activityService';
export * from './leagueService';
export * from './exportsService';
export * from './usersService';
export * from './settingsService';
export * from './reconciliationService';
export * from './addressService';
export * from './paymentService';
export * from './paymentMetrics';
export * from './notesService';
export * from './healthService';
export * as helpService from './helpService';
