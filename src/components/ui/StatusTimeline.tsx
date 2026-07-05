/* =====================================================================
   StatusTimeline — the Sent → Paid → Deed Issued timeline on the
   application detail view. The reached stage is "current"; earlier stages
   are "done"; later stages are "todo".
   ===================================================================== */
import { Icon } from './Icon';

export interface TimelineStep {
  label: string;
  date: string;
  note: string;
}

// #105 A terminated (withdrawn / expired) application stopped after Sent without
// paying: steps up to `reached` are done, the NEXT step renders as 'terminated'
// (greyed, never a success tick), and later steps stay 'todo'. This makes a false
// Paid/Deed check impossible for a pre-payment exit.
export function StatusTimeline({ steps, reached, terminated }: { steps: TimelineStep[]; reached: number; terminated?: boolean }) {
  return (
    <div className="timeline">
      {steps.map((s, i) => {
        const n = i + 1;
        const state = terminated
          ? (n <= reached ? 'done' : n === reached + 1 ? 'terminated' : 'todo')
          : (n < reached ? 'done' : n === reached ? 'current' : 'todo');
        return (
          <div className={`tl-step tl-step--${state}`} key={s.label}>
            <div className="tl-step__node">
              {state === 'terminated' ? <Icon name="ban" strokeWidth={2.4} /> : state !== 'todo' && <Icon name="check" strokeWidth={2.4} />}
            </div>
            <div className="tl-step__label">{s.label}</div>
            <div className="tl-step__date">{s.date}</div>
            <div className="tl-step__note">{s.note}</div>
          </div>
        );
      })}
    </div>
  );
}
