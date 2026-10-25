/** How folder names from `content/` are shown: `4Wk_FTP_Booster` reads as
 *  `4Wk FTP Booster`, and a nested group `Phase_1/Week_2` as
 *  `Phase 1 / Week 2`. Shared by the builder and the Library. */
export const displayName = (name: string) =>
  name.split('/').map((part) => part.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()).join(' / ');

/**
 * A plan workout's title as shown outside its plan, where there is no
 * sub-folder heading: `Week 1 · Endurance`. Left alone when the title already
 * names a week of its own, that is, it starts with the sub-folder's word and
 * a number (`Week 1.4 - Endurance` in `Week_1/` or `Week1/`). It never reads
 * `Week 1 · Week 1.4 - …`, even where a file's title and folder disagree.
 */
export function titleInPlan(title: string, group: string | undefined): string {
  if (!group) return title;
  // `Week_12` → `week`; compared with separators squeezed out of both
  const squash = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '');
  const word = squash(/^\D*/.exec(group.split('/').pop()!)![0]);
  const head = squash(title);
  if (word && head.startsWith(word) && /\d/.test(head.charAt(word.length))) return title;
  return `${displayName(group)} · ${title}`;
}
