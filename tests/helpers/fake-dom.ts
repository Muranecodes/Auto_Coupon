export class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

export class FakeEvent {
  type: string;
  bubbles: boolean;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = Boolean(init?.bubbles);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (ev: FakeEvent) => void;

export class FakeNode {
  nodeName: string;
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  protected listeners = new Map<string, Set<Listener>>();

  constructor(nodeName: string) {
    this.nodeName = nodeName.toUpperCase();
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: FakeEvent): boolean {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    const set = this.listeners.get(event.type);
    if (set) {
      for (const fn of [...set]) {
        fn.call(this, event);
      }
    }
    const handlerProp = (this as Record<string, unknown>)[`on${event.type}`];
    if (typeof handlerProp === 'function') {
      (handlerProp as Listener).call(this, event);
    }
    if (event.bubbles && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
}

export class FakeElement extends FakeNode {
  tagName: string;
  id = '';
  className = '';
  children: FakeElement[] = [];
  shadowRoot: FakeShadowRoot | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  onclick: Listener | null = null;
  onchange: Listener | null = null;
  oninput: Listener | null = null;
  private attrs = new Map<string, string>();
  private _textContent = '';

  constructor(tagName: string, ownerDocument: FakeDocument | null = null) {
    super(tagName);
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  appendText(val: string): void {
    this._textContent += String(val ?? '');
  }

  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return (
      this._textContent +
      this.children.map((child) => child.textContent).join('')
    );
  }

  set textContent(val: string) {
    this.children = [];
    this._textContent = String(val ?? '');
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(html: string) {
    this.children = [];
    this._textContent = '';
    if (html && html.trim()) {
      const parsed = parseSimpleHtml(html, this.ownerDocument);
      for (const child of parsed) {
        this.appendChild(child);
      }
    }
  }

  setAttribute(name: string, value: string): void {
    const v = String(value);
    this.attrs.set(name, v);
    if (name === 'id') this.id = v;
    if (name === 'class') {
      if (typeof this.className === 'string') {
        this.className = v;
      } else {
        (this as unknown as { className: unknown }).className = {
          baseVal: v,
          animVal: v,
        };
      }
    }
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[camel] = v;
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || this.attrs.get('id') || null;
    if (name === 'class')
      return (
        (typeof this.className === 'string' && this.className) ||
        this.attrs.get('class') ||
        null
      );
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  removeChild<T extends FakeElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
  }

  attachShadow(_init: { mode: 'open' | 'closed' }): FakeShadowRoot {
    const root = new FakeShadowRoot(this.ownerDocument);
    this.shadowRoot = root;
    return root;
  }

  click(): void {
    if ((this as unknown as FakeInputElement).type === 'checkbox') {
      const inp = this as unknown as FakeInputElement;
      inp.checked = !inp.checked;
      this.dispatchEvent(new FakeEvent('change', { bubbles: true }));
    }
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }

  querySelector<T extends FakeElement = FakeElement>(
    selector: string,
  ): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(
    selector: string,
  ): T[] {
    const selectors = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const results: T[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (selectors.some((sel) => matchesSelector(child, sel))) {
          results.push(child as T);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

export class FakeShadowRoot extends FakeElement {
  constructor(ownerDocument: FakeDocument | null = null) {
    super('#shadow-root', ownerDocument);
  }
}

export class FakeInputElement extends FakeElement {
  private _value = '';
  checked = false;
  disabled = false;
  placeholder = '';
  type = 'text';

  constructor(tagName = 'INPUT', ownerDocument: FakeDocument | null = null) {
    super(tagName, ownerDocument);
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = String(v ?? '');
  }

  override setAttribute(name: string, value: string): void {
    super.setAttribute(name, value);
    if (name === 'value') this._value = value;
    if (name === 'placeholder') this.placeholder = value;
    if (name === 'type') this.type = value;
    if (name === 'checked') this.checked = value !== 'false';
    if (name === 'disabled') this.disabled = value !== 'false';
  }
}

export class FakeButtonElement extends FakeElement {
  disabled = false;
  type = 'button';
}

export class FakeDocument extends FakeNode {
  body: FakeElement;
  head: FakeElement;
  documentElement: FakeElement;

  constructor() {
    super('#document');
    this.ownerDocument = this;
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): FakeElement {
    const upper = tagName.toUpperCase();
    if (upper === 'INPUT' || upper === 'TEXTAREA') {
      return new FakeInputElement(upper, this);
    }
    if (upper === 'BUTTON') {
      return new FakeButtonElement(upper, this);
    }
    const el = new FakeElement(upper, this);
    if (upper === 'SVG' || upper === 'PATH') {
      // In real browsers, SVGElement.className is an SVGAnimatedString object, not a string!
      (el as unknown as { className: unknown }).className = {
        baseVal: '',
        animVal: '',
      };
    }
    return el;
  }

  querySelector<T extends FakeElement = FakeElement>(
    selector: string,
  ): T | null {
    return this.documentElement.querySelector<T>(selector);
  }

  querySelectorAll<T extends FakeElement = FakeElement>(
    selector: string,
  ): T[] {
    return this.documentElement.querySelectorAll<T>(selector);
  }
}

function matchesSingleToken(el: FakeElement, token: string): boolean {
  let rem = token.trim();
  if (!rem) return false;

  const attrRegex = /\[([a-zA-Z0-9_-]+)(?:([*^$~|]?=)['"]?([^'"\]]*)['"]?)?\]/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(rem)) !== null) {
    const attrName = attrMatch[1]!;
    const op = attrMatch[2];
    const expected = attrMatch[3] ?? '';
    const actual =
      attrName === 'placeholder' && el instanceof FakeInputElement
        ? el.placeholder || el.getAttribute('placeholder')
        : attrName === 'type' &&
            (el instanceof FakeInputElement || el instanceof FakeButtonElement)
          ? el.type || el.getAttribute('type')
          : el.getAttribute(attrName);
    if (actual === null) return false;
    if (op === '=') {
      if (actual !== expected) return false;
    } else if (op === '*=') {
      if (!actual.includes(expected)) return false;
    } else if (op === '^=') {
      if (!actual.startsWith(expected)) return false;
    } else if (op === '$=') {
      if (!actual.endsWith(expected)) return false;
    }
  }
  rem = rem.replace(attrRegex, '');

  const idMatch = rem.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    if (el.id !== idMatch[1]) return false;
    rem = rem.replace(/#[a-zA-Z0-9_-]+/, '');
  }

  const classMatches = [...rem.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
  if (classMatches.length > 0) {
    const rawClass =
      typeof el.className === 'string'
        ? el.className
        : (el.getAttribute('class') ?? '');
    const classList = rawClass.split(/\s+/).filter(Boolean);
    for (const cm of classMatches) {
      if (!classList.includes(cm[1]!)) return false;
    }
    rem = rem.replace(/\.[a-zA-Z0-9_-]+/g, '');
  }

  rem = rem.trim();
  if (rem && rem !== '*') {
    if (el.tagName !== rem.toUpperCase()) return false;
  }
  return true;
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  if (parts.length === 0) return false;
  if (!matchesSingleToken(el, parts[parts.length - 1]!)) return false;
  let curr: FakeElement | null = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i]!;
    while (curr && !matchesSingleToken(curr, part)) {
      curr = curr.parentElement;
    }
    if (!curr) return false;
    curr = curr.parentElement;
  }
  return true;
}

const VOID_TAGS = new Set([
  'INPUT',
  'BR',
  'HR',
  'IMG',
  'META',
  'LINK',
]);

function parseSimpleHtml(
  html: string,
  ownerDocument: FakeDocument | null,
): FakeElement[] {
  const root = new FakeElement('root', ownerDocument);
  const stack: FakeElement[] = [root];
  const tokenRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9_-]+)\s*>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = tokenRegex.exec(html)) !== null) {
    const closeTag = match[1];
    const openTag = match[2];
    const attrStr = match[3] ?? '';
    const selfClosing = Boolean(match[4]) || (openTag && VOID_TAGS.has(openTag.toUpperCase()));
    const textNode = match[5];

    const current = stack[stack.length - 1]!;
    if (closeTag) {
      if (stack.length > 1) stack.pop();
    } else if (openTag) {
      const el = ownerDocument
        ? ownerDocument.createElement(openTag)
        : new FakeElement(openTag, null);
      const attrPattern = /([a-zA-Z0-9_:-]+)(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let am;
      while ((am = attrPattern.exec(attrStr)) !== null) {
        const attrName = am[1]!;
        const attrVal = am[2] ?? am[3] ?? am[4] ?? '';
        el.setAttribute(attrName, attrVal);
      }
      current.appendChild(el);
      if (!selfClosing) {
        stack.push(el);
      }
    } else if (textNode !== undefined) {
      const trimmed = textNode.replace(/\s+/g, ' ');
      if (trimmed.trim()) {
        current.appendText(trimmed.trim());
      }
    }
  }
  return [...root.children];
}

export function installFakeDom(initialUrl = 'https://www.foodpanda.com.tw/vouchers') {
  const document = new FakeDocument();
  const localStorage = new FakeStorage();
  const sessionStorage = new FakeStorage();
  const clipboardWrites: string[] = [];

  const locationState = {
    _href: initialUrl,
    get href() {
      return this._href;
    },
    set href(next: string) {
      this._href = new URL(next, this._href).toString();
    },
    get origin() {
      return new URL(this._href).origin;
    },
    get hostname() {
      return new URL(this._href).hostname;
    },
    get pathname() {
      return new URL(this._href).pathname;
    },
    assign(next: string) {
      this.href = next;
    },
  };

  const windowObj = {
    document,
    localStorage,
    sessionStorage,
    location: locationState,
    Event: FakeEvent,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeInputElement,
    HTMLButtonElement: FakeButtonElement,
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          clipboardWrites.push(text);
        },
      },
    },
  };

  Object.assign(globalThis, {
    window: windowObj,
    document,
    localStorage,
    sessionStorage,
    location: locationState,
    Event: FakeEvent,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeInputElement,
    HTMLButtonElement: FakeButtonElement,
  });

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: windowObj.navigator,
      configurable: true,
      writable: true,
    });
  } catch {
    // ignore if non-configurable
  }

  return {
    document,
    window: windowObj,
    localStorage,
    sessionStorage,
    location: locationState,
    clipboardWrites,
  };
}
