/* =====================================================================
   Help & resources service.
   opndoor admins add / edit / delete resources, FAQs and account managers;
   changes persist so every portal user sees the same content.

   INTEGRATION: getHelpContent -> GET /help; the mutators -> the matching
   create/update/delete endpoints, with real file upload replacing the
   client-side data-URL storage.
   ===================================================================== */
import type { HelpContent, HelpManager, HelpResource, HelpResourceSection } from './types';
import { KEYS, clone, loadJSON, saveJSON } from './storage';
import { HELP_SEED } from './mock/help';

let DATA: HelpContent = load();

function load(): HelpContent {
  const stored = loadJSON<HelpContent | null>(KEYS.help, null);
  if (stored && stored.gettingStarted) return stored;
  return clone(HELP_SEED);
}
function persist(): boolean {
  return saveJSON(KEYS.help, DATA);
}

export function getHelpContent(): HelpContent {
  return DATA;
}

export function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 8);
}

/* ---- resources (getting started + templates) ---- */
export type ResourceDraft = Omit<HelpResource, 'id'>;

/** Add a resource. If persistence fails (e.g. over quota), the add is rolled back. */
export function addResource(section: HelpResourceSection, draft: ResourceDraft): { ok: boolean; id?: string } {
  const rec: HelpResource = { ...draft, id: uid('r') };
  DATA[section].push(rec);
  if (!persist()) {
    DATA[section] = DATA[section].filter((x) => x.id !== rec.id);
    return { ok: false };
  }
  return { ok: true, id: rec.id };
}

export function updateResource(section: HelpResourceSection, id: string, changes: Partial<HelpResource>): { ok: boolean } {
  const target = DATA[section].find((x) => x.id === id);
  if (!target) return { ok: false };
  Object.assign(target, changes);
  return { ok: persist() };
}

export function deleteResource(section: HelpResourceSection, id: string): void {
  DATA[section] = DATA[section].filter((x) => x.id !== id);
  persist();
}

/* ---- FAQs ---- */
export function addFaq(q: string, a: string): void {
  DATA.faqs.push({ id: uid('f'), q, a });
  persist();
}
export function updateFaq(id: string, q: string, a: string): void {
  const it = DATA.faqs.find((x) => x.id === id);
  if (it) {
    it.q = q;
    it.a = a;
    persist();
  }
}
export function deleteFaq(id: string): void {
  DATA.faqs = DATA.faqs.filter((x) => x.id !== id);
  persist();
}

/* ---- account managers ---- */
export function addManager(m: Omit<HelpManager, 'id'>): void {
  DATA.managers.push({ ...m, id: uid('m') });
  persist();
}
export function updateManager(id: string, changes: Partial<HelpManager>): void {
  const it = DATA.managers.find((x) => x.id === id);
  if (it) {
    Object.assign(it, changes);
    persist();
  }
}
export function deleteManager(id: string): void {
  DATA.managers = DATA.managers.filter((x) => x.id !== id);
  persist();
}
export function findResource(section: HelpResourceSection, id: string): HelpResource | undefined {
  return DATA[section].find((x) => x.id === id);
}
