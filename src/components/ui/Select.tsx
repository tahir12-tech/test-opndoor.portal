/* =====================================================================
   Styled dropdowns used by the dashboard and the org partner selector:
   PeriodSelect, MeasureSelect, TrendSelect, PartnerSelect. Thin wrappers
   around a native <select> with the shared pill styling.
   ===================================================================== */
import type { CSSProperties } from 'react';
import './Select.css';

export interface Option {
  value: string;
  label: string;
}

interface SelectProps {
  className: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  ariaLabel?: string;
  title?: string;
  id?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

function StyledSelect({ className, value, onChange, options, ariaLabel, title, id, style, disabled }: SelectProps) {
  return (
    <select
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      title={title}
      id={id}
      style={style}
      disabled={disabled}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PeriodSelect(p: Omit<SelectProps, 'className'>) {
  return <StyledSelect className="period-select" {...p} />;
}
export function MeasureSelect(p: Omit<SelectProps, 'className'>) {
  return <StyledSelect className="measure-select" {...p} />;
}
export function TrendSelect(p: Omit<SelectProps, 'className'>) {
  return <StyledSelect className="trend-select" {...p} />;
}
/** The org partner selector reuses the period-select pill look. */
export function PartnerSelect(p: Omit<SelectProps, 'className'>) {
  return <StyledSelect className="period-select" {...p} />;
}
