/* =====================================================================
   Notes service (#8) — free-text operational notes on an application.

   Internal-only: notes are visible to opndoor admin + Management + the owning
   referrer, on the application detail page ONLY. They are append-only (no edits
   or deletes) and never sync, export, or appear on any tenant/agent surface.

   Live mode: reads select from app_notes via the anon client (RLS scopes the
   rows to what the caller may see, exactly like the activity log), resolving the
   guarantee_ref to the application id first. Writes go through the
   add_application_note RPC (SECURITY DEFINER), which re-checks AAL2 + permission
   and stamps the author. Mock/test mode keeps an in-memory store keyed by ref so
   the demo works and the smoke tests pass, seeded with one example note.
   ===================================================================== */
import { SUPABASE_ENABLED, sb } from '@/lib/supabase';

export interface AppNote {
  id: string;
  body: string;
  /** Display name of the author who added the note (null if unknown). */
  author: string | null;
  /** ISO timestamp the note was added. */
  at: string;
}

/* ---------- mock/test store (keyed by guarantee_ref) ---------- */

// Newest-first per ref. Seeded lazily on first read so every demo record shows
// one example operational note, and additions persist for the session.
const MOCK_NOTES: Record<string, AppNote[]> = {};
let mockSeq = 0;
const mockId = (): string => `note-mock-${++mockSeq}`;

function mockNotesFor(ref: string): AppNote[] {
  if (!MOCK_NOTES[ref]) {
    MOCK_NOTES[ref] = [
      {
        id: mockId(),
        body: 'Spoke with the branch to confirm the tenancy start date. All documentation received; nothing outstanding.',
        author: 'opndoor admin',
        at: '2026-06-24T10:12:00.000Z',
      },
    ];
  }
  return MOCK_NOTES[ref];
}

/* ---------- reads ---------- */

/** Operational notes for an application, newest first. RLS-scoped in live mode. */
export async function getApplicationNotes(ref: string): Promise<AppNote[]> {
  if (!SUPABASE_ENABLED) return mockNotesFor(ref).slice();
  const client = sb();
  const { data: app } = await client
    .from('applications')
    .select('id')
    .eq('guarantee_ref', ref)
    .maybeSingle();
  if (!app) return [];
  const { data, error } = await client
    .from('app_notes')
    .select('id, body, author, at')
    .eq('application_id', app.id)
    .order('at', { ascending: false });
  if (error || !data) return [];
  return data as AppNote[];
}

/* ---------- writes (append-only; RPC / service-role path) ---------- */

/** Append one operational note to an application. Returns the created note. */
export async function addApplicationNote(ref: string, body: string): Promise<AppNote> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('A note cannot be empty.');
  if (!SUPABASE_ENABLED) {
    const note: AppNote = {
      id: mockId(),
      body: trimmed.slice(0, 2000),
      author: 'You',
      at: new Date().toISOString(),
    };
    mockNotesFor(ref).unshift(note);
    return note;
  }
  const { data, error } = await sb().rpc('add_application_note', { p_ref: ref, p_body: trimmed });
  if (error) throw new Error(error.message || 'Could not add the note.');
  return data as AppNote;
}
