/* =====================================================================
   Toast — the bottom-centre confirmation toasts used across the app.
   useToast() returns a toast(message) function; the provider renders the
   stack in a portal, animating each in and auto-dismissing it.
   ===================================================================== */
/* =====================================================================
   Toast — Global notification system
   Supports: success, error, warning, info
   ===================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import "./Toast.css";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  shown: boolean;
}

type ToastFunction = (
  message: string,
  type?: ToastType
) => void;

const ToastContext = createContext<ToastFunction>(() => {});

const DURATION = 3200;

export function ToastProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback(
    (
      message: string,
      type: ToastType = "success"
    ) => {
      const id = ++seq.current;

      setToasts((prev) => [
        ...prev,
        {
          id,
          message,
          type,
          shown: false,
        },
      ]);

      // Animate in
      requestAnimationFrame(() => {
        setToasts((prev) =>
          prev.map((t) =>
            t.id === id
              ? { ...t, shown: true }
              : t
          )
        );
      });

      // Animate out
      window.setTimeout(() => {
        setToasts((prev) =>
          prev.map((t) =>
            t.id === id
              ? { ...t, shown: false }
              : t
          )
        );
      }, DURATION);

      // Remove from DOM
      window.setTimeout(() => {
        setToasts((prev) =>
          prev.filter((t) => t.id !== id)
        );
      }, DURATION + 260);
    },
    []
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}

      <ToastPortal toasts={toasts} />
    </ToastContext.Provider>
  );
}

function ToastPortal({
  toasts,
}: {
  toasts: ToastItem[];
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const getIconName = (type: ToastType) => {
    switch (type) {
      case "success":
        return "check";

      case "error":
        return "x";

      case "warning":
        return "alert";

      case "info":
        return "info";

      default:
        return "check";
    }
  };

  return createPortal(
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}${
            t.shown ? " is-in" : ""
          }`}
        >
          <Icon
            name={getIconName(t.type)}
            strokeWidth={2.4}
          />

          <span>{t.message}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}

export function useToast(): ToastFunction {
  return useContext(ToastContext);
}