import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { IconButton } from "./Button";
import { uid } from "../../lib/id";

export type Tone = "info" | "success" | "warning" | "danger" | "error";
type ToastItem = { id: string; message: string; tone: Tone };
export type Notify = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Notify>(() => undefined);
export const useToast = () => useContext(ToastContext);

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
  error: CircleAlert,
} as const;
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<Notify>((message, tone = "info") => {
    const id = uid();
    setItems((list) => [...list.slice(-(MAX_VISIBLE - 1)), { id, message, tone }]);
    // Errors stay longer: they usually need to be read and acted on.
    const duration = tone === "danger" || tone === "error" ? 9000 : 5000;
    timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
  }, [dismiss]);

  useEffect(() => {
    const active = timers.current;
    return () => { active.forEach((t) => window.clearTimeout(t)); active.clear(); };
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-live="polite" aria-label="Notifications">
        {items.map((t) => {
          const safeTone = t.tone in ICONS ? t.tone : "info";
          const Icon = ICONS[safeTone];
          const normalizedClass = safeTone === "error" ? "danger" : safeTone;
          const isAlert = normalizedClass === "danger" || normalizedClass === "warning";
          return (
            <div key={t.id} className={`toast toast-${normalizedClass}`} role={isAlert ? "alert" : "status"}>
              <Icon className="tone" size={18} aria-hidden="true" />
              <span className="toast-msg">{t.message}</span>
              <IconButton icon={X} label="Dismiss notification" size="sm" onClick={() => dismiss(t.id)} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
