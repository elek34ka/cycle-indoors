import { el, qs } from './dom';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  /** null for a notice, with only the confirm button */
  cancelText?: string | null;
  /** styles the confirm button as destructive */
  danger?: boolean;
}

/**
 * A modal yes/no. Deliberately not `window.confirm`: that blocks the animation
 * loop, cannot be styled, and is suppressed in some embedded browsers.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'overlay confirm-overlay' });
    let settled = false;

    const close = (answer: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(answer);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); close(true); }
    };

    const cancel = options.cancelText === null ? null : el('button', {
      class: 'btn', text: options.cancelText ?? 'Cancel',
      on: { click: () => close(false) },
    });
    const confirm = el('button', {
      class: options.danger ? 'btn btn-danger' : 'btn btn-primary',
      text: options.confirmText,
      on: { click: () => close(true) },
    });

    overlay.append(el('div', { class: 'summary-card confirm-card' }, [
      el('h2', { text: options.title }),
      el('p', { text: options.message }),
      el('div', { class: 'summary-actions' }, [cancel, confirm]),
    ]));

    // Clicking the backdrop is a cancel, but only the backdrop itself.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
    });

    document.addEventListener('keydown', onKey, true);
    qs('#app').append(overlay);
    (cancel ?? confirm).focus();
  });
}

/** A modal with one button, for something the rider must read. */
export async function noticeDialog(options: Omit<ConfirmOptions, 'cancelText' | 'danger'>): Promise<void> {
  await confirmDialog({ ...options, cancelText: null });
}
