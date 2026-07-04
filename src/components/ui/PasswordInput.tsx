/* =====================================================================
   Password input with a show/hide (eye) toggle (#78). Drops into the same
   .field wrapper as a plain input: keep the surrounding <div class="field">
   and <label>, and use this in place of the <input type="password">.
   Used on login, accept-invite and reset-password.
   ===================================================================== */
import { useState, type InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function PasswordInput(props: Props) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-input">
      <input {...props} type={show ? 'text' : 'password'} />
      <button
        type="button"
        className="pw-input__toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        title={show ? 'Hide password' : 'Show password'}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  );
}
