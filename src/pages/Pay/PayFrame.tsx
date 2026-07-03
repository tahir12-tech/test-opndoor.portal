/* Shared branded frame for the public tenant payment pages. Module-level (not
   redefined per render) so polling re-renders don't remount the card. */
import type { ReactNode } from 'react';
import './Pay.css';

export function PayFrame({ children }: { children: ReactNode }) {
  return (
    <div className="pay">
      <div className="pay__brand"><span className="pay__wordmark">opndoor</span></div>
      <div className="pay__card">{children}</div>
      <p className="pay__foot">A guarantee by opndoor. Questions? <a href="mailto:hello@opndoor.co">hello@opndoor.co</a></p>
    </div>
  );
}
