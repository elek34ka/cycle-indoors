import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CANVAS_METHODS = [
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
  'rect', 'roundRect', 'fill', 'stroke', 'save', 'restore', 'clip', 'setTransform', 'setLineDash',
  'fillText', 'strokeText', 'translate', 'scale', 'createLinearGradient',
];

/** Boot a jsdom window from index.html with just enough canvas to run the UI. */
export function setupDom(): JSDOM {
  const html = readFileSync('index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const fakeContext = () => {
    const ctx: Record<string, unknown> = {
      canvas: null, font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '',
      lineWidth: 1, globalAlpha: 1, lineJoin: '',
      measureText: () => ({ width: 40 }),
    };
    for (const name of CANVAS_METHODS) {
      ctx[name] = name === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {};
    }
    return ctx;
  };
  window.HTMLCanvasElement.prototype.getContext = fakeContext as never;

  // jsdom reports every element as 0x0, which makes canvas sizing and Leaflet's
  // zoom maths degenerate. Give everything a plausible box instead.
  for (const [name, value] of [['clientWidth', 320], ['clientHeight', 200]] as const) {
    Object.defineProperty(window.Element.prototype, name, { get: () => value, configurable: true });
  }
  window.Element.prototype.getBoundingClientRect = function rect(): DOMRect {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 200, width: 320, height: 200,
      toJSON: () => ({}),
    } as DOMRect;
  };

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

  const globals = globalThis as Record<string, unknown>;
  // Node exposes `navigator` as a getter, so it needs redefining rather than assigning.
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  globals.window = window;
  globals.document = window.document;
  globals.DOMParser = window.DOMParser;
  globals.localStorage = window.localStorage;
  globals.ResizeObserver = ResizeObserverStub;
  globals.Node = window.Node;
  globals.Element = window.Element;
  globals.HTMLElement = window.HTMLElement;
  globals.Event = window.Event;
  globals.CustomEvent = window.CustomEvent;
  globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globals.devicePixelRatio = 1;
  globals.Blob = window.Blob;
  globals.URL = window.URL;
  return dom;
}
