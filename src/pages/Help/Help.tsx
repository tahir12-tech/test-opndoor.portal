/* =====================================================================
   Help & resources — getting-started guides, templates, FAQs and account
   managers, with live search. opndoor admins add / edit / delete content
   (with file upload) and it persists for all users; partner users see it
   read-only. Resources open in an in-page viewer or download.

   INTEGRATION: helpService.getHelpContent + the mutators back these; real
   file upload replaces the client-side data-URL storage.
   ===================================================================== */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { helpService, type HelpResource, type HelpResourceSection } from '@/data';
import { useSession } from '@/session/SessionContext';
import { usePageMeta } from '@/components/layout/pageMeta';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Card, CardBody } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import './Help.css';

const RES_IC: Record<string, IconName> = { doc: 'file', video: 'video', deed: 'file', users: 'users', image: 'image' };

function humanSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function iconFromName(name: string): [string, string] {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return ['video', 'Video'];
  if (['zip', 'rar'].includes(ext)) return ['image', 'ZIP'];
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return ['image', 'Image'];
  if (['doc', 'docx'].includes(ext)) return ['doc', 'DOC'];
  if (['ppt', 'pptx'].includes(ext)) return ['doc', 'PPT'];
  return ['doc', 'PDF'];
}
function fileToBlobUrl(file: NonNullable<HelpResource['file']>): string | null {
  try {
    const parts = file.url.split(',');
    const meta = parts[0];
    const b64 = parts[1];
    const mime = (meta.match(/:(.*?);/) || [null, file.mime || 'application/octet-stream'])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime as string }));
  } catch {
    return null;
  }
}
function imageMime(m?: string): boolean {
  return /^image\//.test(m || '');
}
/** An href we can actually open here: an absolute web URL, or an inline data/blob
    URL. A RELATIVE href (e.g. a ported "guide/*.html" whose asset is not shipped
    with this app) would resolve against this SPA and, when the file is absent,
    fall back to index.html, embedding the whole portal in the viewer (#75). We
    never treat such an href as a real file, so an empty resource always shows the
    placeholder instead of the app. */
function servableHref(r: HelpResource): string | null {
  const h = (r.href || '').trim();
  return /^(https?:|data:|blob:)/i.test(h) ? h : null;
}
/** A resource is openable only when it has an uploaded file or a servable href. */
function hasResourceFile(r: HelpResource): boolean {
  return !!r.file?.url || !!servableHref(r);
}
function previewable(r: HelpResource): boolean {
  const h = servableHref(r);
  if (h) return /\.(html?|pdf)(\?|#|$)/i.test(h) || /^data:(text\/html|application\/pdf)/i.test(h);
  const m = r.file?.mime || '';
  const n = r.file?.name || '';
  return imageMime(m) || m === 'application/pdf' || /\.pdf$/i.test(n) || m === 'text/html' || /\.html?$/i.test(n);
}

interface ResourceDraftState {
  section: HelpResourceSection;
  id: string | null;
  title: string;
  desc: string;
  meta: string;
  type: string; // "icon|Type"
}
type PendingFile = HelpResource['file'] | null | false;

export function Help() {
  usePageMeta('help', 'Help & resources', ['Home', 'Help & resources']);
  const { hash } = useLocation();
  const { role } = useSession();
  const isAdmin = role === 'superadmin';
  const toast = useToast();
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const data = helpService.getHelpContent();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // viewer
  const [viewer, setViewer] = useState<{ open: boolean; title: string; src: string; isImg: boolean; blob: string | null; href?: string; empty?: boolean } | null>(null);

  // resource modal
  const [resDraft, setResDraft] = useState<ResourceDraftState | null>(null);
  const [pendingFile, setPendingFile] = useState<PendingFile>(null);
  const [chipName, setChipName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // faq modal
  const [faqDraft, setFaqDraft] = useState<{ id: string | null; q: string; a: string } | null>(null);
  // manager modal
  const [mgrDraft, setMgrDraft] = useState<{ id: string | null; name: string; role: string; email: string; phone: string } | null>(null);
  // consequence-aware delete confirmation (portal-wide destructive-action pattern)
  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; run: () => void } | null>(null);
  function runConfirm() { if (!confirm) return; confirm.run(); setConfirm(null); }

  // Scroll to the anchored section when arriving via a hash link (e.g. the
  // topbar Help menu's /help#faqs). React Router does not hash-scroll, and the
  // scroll container is .content (not window), so scroll the target into view.
  useEffect(() => {
    if (!hash) return;
    const id = hash.slice(1);
    const raf = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, [hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewer?.open) closeViewer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  const matchRes = (r: HelpResource) => !q || `${r.title} ${r.desc} ${r.type}`.toLowerCase().includes(q);
  const matchFaq = (f: { q: string; a: string }) => !q || `${f.q} ${f.a}`.toLowerCase().includes(q);

  // ---- viewer ----
  function download(r: HelpResource) {
    const a = document.createElement('a');
    const h = servableHref(r);
    if (h) {
      a.href = h;
      a.target = '_blank';
      a.rel = 'noopener';
    } else if (r.file) {
      const u = fileToBlobUrl(r.file);
      if (!u) {
        toast('Could not open this file.');
        return;
      }
      a.href = u;
      a.download = r.file.name;
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    } else return;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  function openResourceFile(r: HelpResource, forceDownload: boolean) {
    const h = servableHref(r);
    if (!h && !r.file?.url) {
      // Empty resource (no upload, or only a non-servable relative href): open the
      // viewer in placeholder mode. Never fall through to an iframe, so the app is
      // never embedded (#75).
      setViewer({ open: true, title: r.title || 'Resource', src: '', isImg: false, blob: null, empty: true });
      return;
    }
    if (forceDownload || !previewable(r)) {
      download(r);
      return;
    }
    const src = h ? h : fileToBlobUrl(r.file!);
    if (!src) {
      toast('Could not open this file.');
      return;
    }
    setViewer({ open: true, title: r.title || 'Resource', src, isImg: h ? false : imageMime(r.file?.mime), blob: h ? null : src, href: h ?? undefined });
  }
  function closeViewer() {
    if (viewer?.blob) {
      const b = viewer.blob;
      setTimeout(() => URL.revokeObjectURL(b), 200);
    }
    setViewer(null);
  }

  // ---- resource modal ----
  function openResource(section: HelpResourceSection, id?: string) {
    const r = id ? helpService.findResource(section, id) : undefined;
    setResDraft({ section, id: id || null, title: r?.title || '', desc: r?.desc || '', meta: r?.meta || '', type: r ? `${r.icon}|${r.type}` : 'doc|PDF' });
    setPendingFile(null);
    setChipName(r?.file?.url ? r.file.name : null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  function readFile(file: File) {
    if (file.size > 4 * 1048576) {
      toast('That file is over 4 MB. Please choose a smaller file for the demo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPendingFile({ name: file.name, url: String(reader.result), mime: file.type || '' });
      setChipName(file.name);
      const t = iconFromName(file.name);
      setResDraft((d) => (d ? { ...d, type: `${t[0]}|${t[1]}`, meta: d.meta.trim() || humanSize(file.size), title: d.title.trim() || file.name.replace(/\.[^.]+$/, '') } : d));
    };
    reader.readAsDataURL(file);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  }
  function saveResource() {
    if (!resDraft || !resDraft.title.trim()) return;
    const [icon, type] = resDraft.type.split('|');
    const base = { title: resDraft.title.trim(), desc: resDraft.desc.trim(), icon, type, meta: resDraft.meta.trim() || type };
    if (resDraft.id) {
      const changes: Partial<HelpResource> = { ...base };
      if (pendingFile) changes.file = pendingFile;
      const ok = helpService.updateResource(resDraft.section, resDraft.id, changes).ok;
      if (pendingFile === false) {
        const existing = helpService.findResource(resDraft.section, resDraft.id);
        if (existing) delete existing.file;
      }
      if (!ok) return;
      toast('Resource updated for all users.');
    } else {
      const draft: Omit<HelpResource, 'id'> = { ...base };
      if (pendingFile) draft.file = pendingFile;
      const res = helpService.addResource(resDraft.section, draft);
      if (!res.ok) {
        toast('Storage limit reached. Try a smaller file or remove an old resource.');
        return;
      }
      toast('Resource added and published to all users.');
    }
    setResDraft(null);
    refresh();
  }
  function deleteResource() {
    if (!resDraft?.id) return;
    helpService.deleteResource(resDraft.section, resDraft.id);
    setResDraft(null);
    refresh();
    toast('Resource deleted for all users.');
  }

  // ---- faq / manager ----
  function saveFaq() {
    if (!faqDraft || !faqDraft.q.trim()) return;
    if (faqDraft.id) helpService.updateFaq(faqDraft.id, faqDraft.q.trim(), faqDraft.a.trim());
    else helpService.addFaq(faqDraft.q.trim(), faqDraft.a.trim());
    toast(faqDraft.id ? 'FAQ updated for all users.' : 'FAQ added and published to all users.');
    setFaqDraft(null);
    refresh();
  }
  function saveManager() {
    if (!mgrDraft || !mgrDraft.name.trim()) return;
    const payload = { name: mgrDraft.name.trim(), role: mgrDraft.role.trim() || 'opndoor Partnerships', email: mgrDraft.email.trim(), phone: mgrDraft.phone.trim() };
    if (mgrDraft.id) helpService.updateManager(mgrDraft.id, payload);
    else helpService.addManager(payload);
    toast(mgrDraft.id ? 'Account manager updated.' : 'Account manager added.');
    setMgrDraft(null);
    refresh();
  }

  // ---- render helpers ----
  function ResourceCard({ r, section }: { r: HelpResource; section: HelpResourceSection }) {
    const hasFile = hasResourceFile(r);
    const metaRight = hasFile ? r.meta : isAdmin ? 'No file yet · edit to upload' : 'Coming soon';
    const icClass = r.icon === 'video' ? ' res__ic--video' : r.icon === 'deed' ? ' res__ic--deed' : '';
    return (
      <a className="res" href="#" onClick={(e) => { e.preventDefault(); openResourceFile(r, (e.target as HTMLElement).closest('.res__dl') != null); }}>
        {isAdmin && (
          <div className="res__admin">
            <button className="mini" title="Edit" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openResource(section, r.id); }}><Icon name="edit" /></button>
            <button className="mini mini--danger" title="Delete" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirm({ title: 'Delete resource?', body: <>Delete <b>{r.title || 'this resource'}</b>? It is removed for all users and cannot be undone.</>, run: () => { helpService.deleteResource(section, r.id); refresh(); toast('Resource deleted for all users.'); } }); }}><Icon name="trash" /></button>
          </div>
        )}
        {hasFile && <span className="res__dl" title={servableHref(r) ? 'Open' : 'Download'}><Icon name={servableHref(r) ? 'external' : 'download'} /></span>}
        <span className={`res__ic${icClass}`}><Icon name={RES_IC[r.icon] || 'file'} strokeWidth={1.8} /></span>
        <div>
          <div className="res__t">{r.title}</div>
          <div className="res__s">{r.desc}</div>
          <div className="res__meta"><span className={hasFile ? 'res__type' : 'res__type res__type--empty'}>{r.type}</span><span>{metaRight}</span></div>
        </div>
      </a>
    );
  }

  function renderSection(section: HelpResourceSection, addLabel: string) {
    const items = data[section].filter(matchRes);
    return (
      <div className="res-grid">
        {items.map((r) => <ResourceCard key={r.id} r={r} section={section} />)}
        {items.length === 0 && q && <div className="muted" style={{ fontSize: 13, padding: '6px 2px' }}>No matches in this section.</div>}
        {isAdmin && !q && (
          <a className="res res--upload" href="#" onClick={(e) => { e.preventDefault(); openResource(section); }}>
            <Icon name="upload" strokeWidth={1.8} />
            <div className="res__t">{addLabel}</div>
            <div className="res__s">Visible to all portal users</div>
          </a>
        )}
      </div>
    );
  }

  const faqs = data.faqs.filter(matchFaq);
  const initials = (n: string) => n.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <>
      <div className="help-hero">
        <span className="help-hero__eye">Help &amp; resources</span>
        <h1>Everything you need to refer with confidence</h1>
        <p>Guides, templates and answers for the Guarantee Referral Portal. Resources here are maintained by your opndoor partnerships team.</p>
        <div className="help-hero__search">
          <Icon name="search" />
          <input type="text" placeholder="Search guides and FAQs" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {isAdmin && (
        <div className="rolenote" style={{ marginBottom: 24 }}>
          <Icon name="pen" />
          <span>As an <b>opndoor admin</b> you manage this content: upload and edit resources, change all details and assign the partner's account manager. Management and referrer users see it read-only.</span>
        </div>
      )}

      <div className="help-grid">
        <div>
          <section id="getting-started">
            <div className="section-title">
              <h2>Getting started</h2>
              <span className="count">{data.gettingStarted.length} guides</span>
              {isAdmin && <Button variant="primary" size="sm" className="addbtn" onClick={() => openResource('gettingStarted')}><Icon name="plus" /> Add resource</Button>}
            </div>
            {renderSection('gettingStarted', 'Add resource')}
          </section>

          <section id="templates">
            <div className="section-title">
              <h2>Templates &amp; downloads</h2>
              <span className="count">{data.templates.length} files</span>
              {isAdmin && <Button variant="primary" size="sm" className="addbtn" onClick={() => openResource('templates')}><Icon name="plus" /> Add file</Button>}
            </div>
            {renderSection('templates', 'Add file')}
          </section>

          <section id="faqs">
            <div className="section-title">
              <h2>Frequently asked questions</h2>
              <span className="count">{faqs.length} {faqs.length === 1 ? 'answer' : 'answers'}</span>
              {isAdmin && <Button variant="primary" size="sm" className="addbtn" onClick={() => setFaqDraft({ id: null, q: '', a: '' })}><Icon name="plus" /> Add FAQ</Button>}
            </div>
            <div>
              {faqs.length === 0 ? (
                <div className="muted" style={{ fontSize: 13, padding: '6px 2px' }}>No FAQs match your search.</div>
              ) : (
                faqs.map((f, i) => (
                  <details className="faq" key={f.id} open={i === 0}>
                    <summary className="faq__q">
                      <span className="faq__num">{i + 1}</span>
                      {f.q}
                      {isAdmin && (
                        <span className="faq__admin">
                          <button className="mini" title="Edit" onClick={(e) => { e.preventDefault(); setFaqDraft({ id: f.id, q: f.q, a: f.a }); }}><Icon name="edit" /></button>
                          <button className="mini mini--danger" title="Delete" onClick={(e) => { e.preventDefault(); setConfirm({ title: 'Delete FAQ?', body: <>Delete the FAQ <b>&ldquo;{f.q}&rdquo;</b>? It is removed for all users and cannot be undone.</>, run: () => { helpService.deleteFaq(f.id); refresh(); toast('FAQ deleted for all users.'); } }); }}><Icon name="trash" /></button>
                        </span>
                      )}
                      <Icon name="chevronRight" className="faq__chev" size={18} strokeWidth={2.2} />
                    </summary>
                    <div className="faq__a" dangerouslySetInnerHTML={{ __html: f.a }} />
                  </details>
                ))
              )}
            </div>
          </section>
        </div>

        {/* RAIL */}
        <aside className="help-rail">
          <Card>
            <CardBody style={{ padding: 16 }}>
              <div className="jump">
                <a href="#getting-started"><Icon name="book" />Getting started</a>
                <a href="#templates"><Icon name="download" />Templates &amp; downloads</a>
                <a href="#faqs"><Icon name="help" />FAQs</a>
              </div>
            </CardBody>
          </Card>

          <Card className="contact-card">
            <CardBody>
              <div className="spread" style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-mute)' }}>Account managers</div>
                {isAdmin && <button className="mini" title="Add account manager" onClick={() => setMgrDraft({ id: null, name: '', role: 'opndoor Partnerships', email: '', phone: '' })}><Icon name="plus" /></button>}
              </div>
              <div>
                {data.managers.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>No account manager assigned yet.</div>
                ) : (
                  data.managers.map((m) => (
                    <div className="am-row" key={m.id}>
                      <span className="am-row__av">{m.name.trim() ? initials(m.name) : 'OP'}</span>
                      <div>
                        <div className="am-row__n">{m.name.trim() ? m.name : 'Your account manager'}</div>
                        <div className="am-row__r">{m.role}</div>
                        <div className="am-row__c">
                          <a href={`mailto:${m.email}`} style={{ color: 'var(--heliotrope-deep)', fontWeight: 700 }}>{m.email}</a>
                          {m.phone.trim() ? ` · ${m.phone}` : ''}
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="am-row__act">
                          <button className="mini" title="Edit" onClick={() => setMgrDraft({ id: m.id, name: m.name, role: m.role, email: m.email, phone: m.phone })}><Icon name="edit" /></button>
                          <button className="mini mini--danger" title="Delete" onClick={() => setConfirm({ title: 'Remove account manager?', body: <>Remove <b>{m.name.trim() || 'this account manager'}</b>? They will no longer appear on the Help page. This cannot be undone.</>, run: () => { helpService.deleteManager(m.id); refresh(); toast('Account manager removed.'); } })}><Icon name="trash" /></button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </CardBody>
          </Card>
        </aside>
      </div>

      {/* RESOURCE MODAL */}
      <Modal
        open={resDraft !== null}
        onClose={() => setResDraft(null)}
        title={resDraft?.id ? 'Edit resource' : 'Add resource'}
        sub="Visible to everyone in the portal."
        footer={
          <>
            {resDraft?.id && <Button variant="quiet" onClick={() => setConfirm({ title: 'Delete resource?', body: <>Delete <b>{resDraft?.title || 'this resource'}</b>? It is removed for all users and cannot be undone.</>, run: deleteResource })} style={{ color: 'var(--danger)' }}>Delete</Button>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <Button variant="ghost" onClick={() => setResDraft(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveResource}>Save</Button>
            </div>
          </>
        }
      >
        {resDraft && (
          <>
            <Field label="Title" htmlFor="res-title"><input id="res-title" type="text" placeholder="e.g. Portal quick-start guide" value={resDraft.title} onChange={(e) => setResDraft({ ...resDraft, title: e.target.value })} /></Field>
            <Field label="Description" htmlFor="res-desc"><textarea id="res-desc" rows={2} placeholder="Short summary of the resource" value={resDraft.desc} onChange={(e) => setResDraft({ ...resDraft, desc: e.target.value })} /></Field>
            <Field label="File">
              {!chipName ? (
                <label className={`dropzone${dragging ? ' is-drag' : ''}`} htmlFor="res-file" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { e.preventDefault(); setDragging(false); }} onDrop={onDrop}>
                  <input ref={fileInputRef} type="file" id="res-file" accept=".pdf,.doc,.docx,.ppt,.pptx,.zip,.png,.jpg,.jpeg,.gif,.mp4,.mov,.webm" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
                  <span className="dropzone__ic"><Icon name="upload" strokeWidth={1.8} /></span>
                  <span className="dropzone__text"><b>Choose a file</b> or drag it here<br /><span className="muted">PDF, Word, PowerPoint, ZIP, image or video · up to 4 MB</span></span>
                </label>
              ) : (
                <div className="filechip">
                  <span className="filechip__ic"><Icon name="file" strokeWidth={1.8} /></span>
                  <span className="filechip__name">{chipName}</span>
                  <button type="button" className="filechip__x" aria-label="Remove file" onClick={() => { setPendingFile(false); setChipName(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}><Icon name="x" /></button>
                </div>
              )}
            </Field>
            <div className="form-grid">
              <Field label="Type" htmlFor="res-type">
                <select id="res-type" value={resDraft.type} onChange={(e) => setResDraft({ ...resDraft, type: e.target.value })}>
                  <option value="doc|PDF">PDF document</option>
                  <option value="video|Video">Video</option>
                  <option value="deed|PDF">Deed / legal (PDF)</option>
                  <option value="users|PDF">Guide (PDF)</option>
                  <option value="image|ZIP">Assets (ZIP)</option>
                </select>
              </Field>
              <Field label="Size / length" htmlFor="res-meta"><input id="res-meta" type="text" placeholder="e.g. 6 pages · 1.2 MB" value={resDraft.meta} onChange={(e) => setResDraft({ ...resDraft, meta: e.target.value })} /></Field>
            </div>
          </>
        )}
      </Modal>

      {/* FAQ MODAL */}
      <Modal
        open={faqDraft !== null}
        onClose={() => setFaqDraft(null)}
        title={faqDraft?.id ? 'Edit FAQ' : 'Add FAQ'}
        sub="Visible to everyone in the portal."
        footer={
          <>
            {faqDraft?.id && <Button variant="quiet" onClick={() => setConfirm({ title: 'Delete FAQ?', body: <>Delete this FAQ? It is removed for all users and cannot be undone.</>, run: () => { helpService.deleteFaq(faqDraft.id!); setFaqDraft(null); refresh(); toast('FAQ deleted for all users.'); } })} style={{ color: 'var(--danger)' }}>Delete</Button>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <Button variant="ghost" onClick={() => setFaqDraft(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveFaq}>Save</Button>
            </div>
          </>
        }
      >
        {faqDraft && (
          <>
            <Field label="Question" htmlFor="faq-q"><input id="faq-q" type="text" placeholder="e.g. How do I send a referral?" value={faqDraft.q} onChange={(e) => setFaqDraft({ ...faqDraft, q: e.target.value })} /></Field>
            <Field label="Answer" htmlFor="faq-a"><textarea id="faq-a" rows={4} placeholder="Write the answer. Basic HTML such as <b>bold</b> is allowed." value={faqDraft.a} onChange={(e) => setFaqDraft({ ...faqDraft, a: e.target.value })} /></Field>
          </>
        )}
      </Modal>

      {/* ACCOUNT MANAGER MODAL */}
      <Modal
        open={mgrDraft !== null}
        onClose={() => setMgrDraft(null)}
        title={mgrDraft?.id ? 'Edit account manager' : 'Add account manager'}
        sub="Shown to the partner team on this page."
        footer={
          <>
            {mgrDraft?.id && <Button variant="quiet" onClick={() => setConfirm({ title: 'Remove account manager?', body: <>Remove <b>{mgrDraft?.name.trim() || 'this account manager'}</b>? They will no longer appear on the Help page. This cannot be undone.</>, run: () => { helpService.deleteManager(mgrDraft.id!); setMgrDraft(null); refresh(); toast('Account manager removed.'); } })} style={{ color: 'var(--danger)' }}>Delete</Button>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <Button variant="ghost" onClick={() => setMgrDraft(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveManager}>Save</Button>
            </div>
          </>
        }
      >
        {mgrDraft && (
          <div className="form-grid">
            <Field label="Name" htmlFor="am-name"><input id="am-name" type="text" placeholder="e.g. Rosa Hartley" value={mgrDraft.name} onChange={(e) => setMgrDraft({ ...mgrDraft, name: e.target.value })} /></Field>
            <Field label="Team / title" htmlFor="am-role"><input id="am-role" type="text" placeholder="e.g. opndoor Partnerships" value={mgrDraft.role} onChange={(e) => setMgrDraft({ ...mgrDraft, role: e.target.value })} /></Field>
            <Field label="Email" htmlFor="am-email"><input id="am-email" type="email" placeholder="partners@opndoor.co" value={mgrDraft.email} onChange={(e) => setMgrDraft({ ...mgrDraft, email: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="am-phone"><input id="am-phone" type="text" placeholder="020 4577 2100" value={mgrDraft.phone} onChange={(e) => setMgrDraft({ ...mgrDraft, phone: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      {/* DELETE CONFIRMATION (consequence-aware, all Help deletes route here) */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        width={440}
        title={confirm?.title ?? ''}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" className="btn--danger" onClick={runConfirm}>Delete</Button></>}
      >
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.55 }}>{confirm?.body}</p>
      </Modal>

      {/* IN-PAGE VIEWER */}
      {viewer?.open && (
        <div className="viewer-scrim is-open" onMouseDown={(e) => e.target === e.currentTarget && closeViewer()}>
          <div className="viewer" role="dialog" aria-modal="true">
            <div className="viewer__head">
              <span className="viewer__title">{viewer.title}</span>
              {!viewer.empty && <a className="viewer__act" title="Open in new tab" href={viewer.src} target="_blank" rel="noopener"><Icon name="external" /></a>}
              {!viewer.empty && <button className="viewer__act" title="Download" onClick={() => window.open(viewer.href || viewer.src, '_blank', 'noopener')}><Icon name="download" /></button>}
              <button className="viewer__act" title="Close" onClick={closeViewer}><Icon name="x" /></button>
            </div>
            <div className="viewer__body">
              {viewer.empty ? (
                <div className="viewer__empty">
                  <Icon name="file" strokeWidth={1.4} />
                  <p>{isAdmin ? 'No file uploaded yet, edit this resource to upload one' : 'No file uploaded yet.'}</p>
                </div>
              ) : viewer.isImg ? (
                <img src={viewer.src} alt={viewer.title} />
              ) : (
                <iframe src={viewer.src} title={viewer.title} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
