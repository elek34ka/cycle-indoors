type Props = {
  id?: string;
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  type?: string;
  value?: string;
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
  disabled?: boolean;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.disabled !== undefined) (node as unknown as { disabled: boolean }).disabled = props.disabled;
  for (const key of ['type', 'value', 'min', 'max', 'step', 'placeholder'] as const) {
    if (props[key] !== undefined) node.setAttribute(key, String(props[key]));
  }
  for (const [k, v] of Object.entries(props.dataset ?? {})) node.dataset[k] = v;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Element not found: ${selector}`);
  return found;
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

/** Write text only when it changed — keeps the 60 fps dashboard from touching the DOM needlessly. */
export function setText(node: Element, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** A run of text; `strong` runs are drawn as `<b>` so they can be styled apart. */
export interface SubPart {
  text: string;
  strong?: boolean;
}

/** `setText` for mixed runs. Rebuilds only when the joined text changes — a
 *  run's emphasis is fixed by its position, so equal text means equal structure. */
export function setParts(node: Element, parts: SubPart[]): void {
  if (node.textContent === parts.map((p) => p.text).join('')) return;
  clear(node);
  for (const part of parts) {
    node.append(part.strong ? el('b', { text: part.text }) : document.createTextNode(part.text));
  }
}

export function setClass(node: Element, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4200): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast toast-${kind}`, text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  }, ms);
}
