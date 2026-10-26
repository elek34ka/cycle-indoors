import { downloadBytes } from '../activity/fit-export';
import { strava } from '../activity/strava';
import { stamp } from '../core/format';
import { WrongConfirmation, type Backup } from '../backup/backup';
import type { Profile } from '../backup/profile';
import { clear, el, qs, toast } from './dom';
import { confirmDialog, noticeDialog } from './confirm';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The restore warning: what the backup holds, and that it replaces everything. */
export function restoreWarning(profile: Profile): string {
  const made = profile.madeAt ? ` from ${stamp(new Date(profile.madeAt))}` : '';
  return `The backup${made} (${plural(profile.done.length, 'done mark')}, ${plural(profile.rides.length, 'ride')}, `
    + `${plural(profile.library.length, 'My library file')}) will fully replace the done marks, followed plan, settings, `
    + 'ride log and My library on this device. Anything on this device that is not in the backup will be lost.';
}

export const STRAVA_NOTICE = 'Strava is not part of backups. Connect it separately on this device, in Settings → Strava.';

/**
 * The Settings tab's Backup section: create or enter a recovery key, back up,
 * restore, delete, forget. The key is the only way back to a backup; the
 * panel says so before anything is uploaded.
 */
export function buildBackupPanel(backup: Backup): void {
  const host = qs('#backup-panel');
  /** a new key on show, until it is confirmed */
  let shown: string | undefined;
  let entering = false;
  let busy: string | undefined;

  const run = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    busy = label;
    render();
    try {
      await work();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      busy = undefined;
      render();
    }
  };

  const button = (text: string, onClick: () => void, cls = 'btn') =>
    el('button', { type: 'button', class: cls, text, disabled: busy !== undefined, on: { click: onClick } });

  const render = () => {
    clear(host);
    host.append(el('h2', { text: 'Backup' }));

    if (!backup.available) {
      host.append(el('p', {
        class: 'hint backup-unavailable',
        text: 'Backup is unavailable: no backup service is set up for this app, or this browser lacks the encryption it needs.',
      }));
      return;
    }

    if (shown) {
      const typed = el('input', {
        type: 'text', class: 'backup-confirm-input', placeholder: 'Last group',
        attrs: { 'aria-label': 'The last group of the key', autocomplete: 'off', spellcheck: 'false' },
      }) as HTMLInputElement;
      host.append(
        el('p', {
          class: 'hint hint-warn backup-warning',
          text: 'Save this key somewhere safe: a password manager, or the downloaded file. It is the only way to '
            + 'restore your backup. Nobody, including this app, can recover it if it is lost.',
        }),
        el('code', { class: 'backup-key', text: shown }),
        el('div', { class: 'summary-actions' }, [
          button('Copy', () => void copy(shown!)),
          button('Download .txt', () => downloadBytes(new TextEncoder().encode(`${shown}\n`), 'cycle-indoors-recovery-key.txt', 'text/plain')),
        ]),
        el('div', { class: 'field' }, [el('label', { text: 'To confirm you saved it, type its last group' }), typed]),
        el('div', { class: 'summary-actions' }, [
          button('Cancel', () => { shown = undefined; render(); }),
          button(busy ?? 'Confirm and back up', () => void run('Backing up…', async () => {
            try {
              await backup.confirmNewKey(typed.value);
              shown = undefined;
              toast('Backed up.');
            } catch (err) {
              if (err instanceof WrongConfirmation) { toast(err.message, 'error'); return; }
              // The key is kept; only the first backup failed.
              shown = undefined;
              throw err;
            }
          }), 'btn btn-primary backup-confirm'),
        ]),
      );
      return;
    }

    const key = backup.key;
    if (!key) {
      host.append(el('p', {
        class: 'hint',
        text: 'Keep your done marks, followed plan, settings, ride log and My library list safe, and bring them to another '
          + 'browser. Everything is encrypted here before it is sent, with a recovery key only you hold.',
      }));
      if (entering) {
        const input = el('input', {
          type: 'text', class: 'backup-key-input', placeholder: 'ci1-…',
          attrs: { 'aria-label': 'Recovery key', autocomplete: 'off', spellcheck: 'false' },
        }) as HTMLInputElement;
        host.append(
          el('div', { class: 'field' }, [el('label', { text: 'Recovery key' }), input]),
          el('div', { class: 'summary-actions' }, [
            button('Cancel', () => { entering = false; render(); }),
            button('Use this key', () => {
              try {
                backup.enterKey(input.value);
                entering = false;
                toast('Recovery key set. Retrieve profile from cloud brings in the backup.');
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }, 'btn btn-primary backup-use-key'),
          ]),
        );
        return;
      }
      host.append(el('div', { class: 'summary-actions' }, [
        button('Create recovery key', () => { shown = backup.newKey(); render(); }, 'btn btn-primary backup-create'),
        button('I have a key', () => { entering = true; render(); }, 'btn backup-enter'),
      ]));
      return;
    }

    const last = backup.backedUpAt;
    host.append(
      el('p', {
        class: 'hint backup-status',
        text: last ? `Last backed up from this browser ${stamp(new Date(last))}.` : 'Not backed up from this browser yet.',
      }),
      el('div', { class: 'summary-actions' }, [
        button(busy === 'Backing up…' ? busy : 'Store current profile to cloud', () => void run('Backing up…', async () => {
          await backup.backUp();
          toast('Backed up.');
        }), 'btn btn-primary backup-now'),
        button(busy === 'Restoring…' ? busy : 'Retrieve profile from cloud', () => void run('Restoring…', restore), 'btn backup-restore'),
      ]),
      el('details', { class: 'backup-more' }, [
        el('summary', { text: 'Recovery key and more' }),
        el('code', { class: 'backup-key', text: key }),
        el('div', { class: 'summary-actions' }, [
          button('Copy key', () => void copy(key)),
          button('Delete backup', () => void run('Deleting…', deleteBackup), 'btn btn-danger backup-delete'),
          button('Forget on this device', () => void forget(), 'btn backup-forget'),
        ]),
      ]),
    );
  };

  const restore = async () => {
    const outcome = await backup.restore({
      confirm: (profile) => confirmDialog({
        title: 'Replace everything on this device?',
        message: restoreWarning(profile),
        confirmText: 'Replace',
        danger: true,
      }),
      restored: () => noticeDialog({
        title: 'Restored',
        message: strava.status === 'connected' ? `${STRAVA_NOTICE} This browser is still connected.` : STRAVA_NOTICE,
        confirmText: 'OK',
      }),
    });
    if (outcome === 'none') toast('There is no backup for this key.', 'error');
  };

  const deleteBackup = async () => {
    const confirmed = await confirmDialog({
      title: 'Delete the backup?',
      message: 'The backup is deleted from the service. Restoring with this key will find nothing until you back up again. '
        + 'Nothing in this browser changes.',
      confirmText: 'Delete backup',
      danger: true,
    });
    if (!confirmed) return;
    await backup.deleteBackup();
    toast('Backup deleted.');
  };

  const forget = async () => {
    const confirmed = await confirmDialog({
      title: 'Forget the key on this device?',
      message: 'Make sure the key is saved somewhere else: without it the backup cannot be restored. The backup itself stays.',
      confirmText: 'Forget',
      danger: true,
    });
    if (!confirmed) return;
    backup.forget();
  };

  backup.on('change', render);
  render();
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Could not copy. Select the key and copy it by hand.', 'error');
  }
}
