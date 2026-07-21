import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  open: boolean;
  title: string;
  initial: string;
  /** Encouragement text (e.g. why a fail note matters). */
  hint?: string;
  onSave: (note: string) => void;
  onClose: () => void;
}

/**
 * Modal note editor. Used both when a step is marked Fail (auto-opened) and via
 * the per-step Note affordance for any status — a note is a sibling of status.
 */
export function FailNoteDialog({ open, title, initial, hint, onSave, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setText(initial);
      // Guard: some non-browser DOMs (jsdom) lack the dialog methods.
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (typeof el.close === 'function') {
      el.close();
    } else {
      el.removeAttribute('open');
    }
  }, [open, initial]);

  return (
    <dialog ref={ref} onCancel={onClose} onClose={onClose}>
      {open && (
        <form
          method="dialog"
          class="stack pad"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(text.trim());
          }}
        >
          <strong>{title}</strong>
          {hint && <p class="hint">{hint}</p>}
          <textarea
            autofocus
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            placeholder="What happened? (optional)"
          />
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" class="primary">
              Save note
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
