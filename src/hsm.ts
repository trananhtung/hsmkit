import type {
  ActionFn,
  GuardFn,
  HSMConfig,
  HSMEvent,
  StateConfig,
  StateId,
  StateListener,
  TransitionConfig,
} from "./types.js";

// ── Internal state node ──────────────────────────────────────────────────────

interface StateNode<Ctx> {
  id: string;
  initial?: string;
  children: Map<string, StateNode<Ctx>>;
  parent?: StateNode<Ctx>;
  transitions: Map<string, TransitionDef<Ctx>[]>;
  entry: ActionFn<Ctx>[];
  exit: ActionFn<Ctx>[];
  history: boolean;
  historyValue?: string;
}

interface TransitionDef<Ctx> {
  target?: string;
  guard?: GuardFn<Ctx>;
  actions: ActionFn<Ctx>[];
}

// ── Builder ──────────────────────────────────────────────────────────────────

function buildNode<Ctx>(
  id: string,
  config: StateConfig<Ctx>,
  parent?: StateNode<Ctx>,
): StateNode<Ctx> {
  const node: StateNode<Ctx> = {
    id,
    initial: config.initial,
    children: new Map(),
    parent,
    transitions: new Map(),
    entry: config.entry
      ? Array.isArray(config.entry) ? config.entry : [config.entry]
      : [],
    exit: config.exit
      ? Array.isArray(config.exit) ? config.exit : [config.exit]
      : [],
    history: config.history ?? false,
  };

  // Build child states
  if (config.states) {
    for (const [childId, childConfig] of Object.entries(config.states)) {
      node.children.set(childId, buildNode(childId, childConfig, node));
    }
  }

  // Parse transitions
  if (config.on) {
    for (const [eventType, transConfig] of Object.entries(config.on)) {
      const defs = parseTransitions(transConfig as string | TransitionConfig<Ctx> | Array<TransitionConfig<Ctx>>);
      node.transitions.set(eventType, defs);
    }
  }

  return node;
}

function parseTransitions<Ctx>(
  raw: string | TransitionConfig<Ctx> | Array<TransitionConfig<Ctx>>,
): TransitionDef<Ctx>[] {
  if (typeof raw === "string") {
    return [{ target: raw, actions: [] }];
  }
  if (Array.isArray(raw)) {
    return raw.map((t) => ({
      target: t.target,
      guard: t.guard,
      actions: t.actions ?? [],
    }));
  }
  return [{ target: raw.target, guard: raw.guard, actions: raw.actions ?? [] }];
}

// ── Path utilities ───────────────────────────────────────────────────────────

function getNodeAtPath<Ctx>(root: StateNode<Ctx>, path: string[]): StateNode<Ctx> {
  let node = root;
  for (const id of path) {
    const child = node.children.get(id);
    if (!child) throw new HSMError(`State "${id}" not found`);
    node = child;
  }
  return node;
}

/** Resolve a dotted target string to a path array from the virtual root. */
function resolvePath(target: string): string[] {
  return target.split(".");
}

/** LCA index: length of longest common prefix of two paths. */
function lcaDepth(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Enter compound state to leaf following initial/history chain. */
function expandToLeaf<Ctx>(
  root: StateNode<Ctx>,
  path: string[],
  ctx: Ctx,
  event: HSMEvent,
): { path: string[]; ctx: Ctx } {
  let cur = getNodeAtPath(root, path);
  let p = [...path];

  while (cur.children.size > 0) {
    if (!cur.initial) throw new HSMError(`Compound state "${p.join(".")}" has no initial substate`);
    const childId = cur.history && cur.historyValue ? cur.historyValue : cur.initial;
    cur = cur.children.get(childId)!;
    for (const fn of cur.entry) ctx = fn(ctx, event) ?? ctx;
    p.push(childId);
  }

  return { path: p, ctx };
}

// ── HSMService ───────────────────────────────────────────────────────────────

export class HSMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HSMError";
  }
}

export class HSMService<Ctx> {
  private _path: string[];
  private _ctx: Ctx;
  private readonly _root: StateNode<Ctx>;
  private readonly _listeners = new Set<StateListener<Ctx>>();

  constructor(root: StateNode<Ctx>, initialPath: string[], ctx: Ctx) {
    this._root = root;
    this._path = initialPath;
    this._ctx = ctx;
  }

  /** Current state as dot-notation string, e.g. `"active.running"`. */
  get state(): string {
    return this._path.join(".");
  }

  /** Current context. */
  get context(): Ctx {
    return this._ctx;
  }

  /** Current state as array path, e.g. `["active", "running"]`. */
  get stateValue(): string[] {
    return [...this._path];
  }

  /**
   * Returns true if the current state matches the given prefix.
   * `matches("active")` returns true for `"active.running"`.
   */
  matches(state: string): boolean {
    const parts = state.split(".");
    return parts.every((part, i) => this._path[i] === part);
  }

  /**
   * Send an event to the machine.
   * Returns this for chaining.
   */
  send(eventType: string, payload: Record<string, unknown> = {}): this {
    const event: HSMEvent = { type: eventType, ...payload };

    // Walk up from current leaf to root looking for applicable transition
    for (let depth = this._path.length; depth >= 0; depth--) {
      const nodePath = this._path.slice(0, depth);
      const node = getNodeAtPath(this._root, nodePath);
      const defs = node.transitions.get(eventType);
      if (!defs) continue;

      for (const def of defs) {
        if (def.guard && !def.guard(this._ctx, event)) continue;

        if (def.target === undefined) {
          // Internal transition — run actions, no exit/entry
          let ctx = this._ctx;
          for (const fn of def.actions) ctx = fn(ctx, event) ?? ctx;
          this._ctx = ctx;
        } else {
          const targetPath = resolvePath(def.target);
          this._doTransition(this._path, nodePath, targetPath, def.actions, event);
        }

        this._notify(event);
        return this;
      }
    }

    return this;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: StateListener<Ctx>): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _notify(event: HSMEvent): void {
    for (const fn of this._listeners) fn(this.state, this._ctx, event);
  }

  private _doTransition(
    currentPath: string[],
    sourcePath: string[],
    targetPath: string[],
    transActions: ActionFn<Ctx>[],
    event: HSMEvent,
  ): void {
    const lca = lcaDepth(currentPath, targetPath);
    let ctx = this._ctx;

    // Exit from current leaf up to (not including) LCA
    for (let i = currentPath.length - 1; i >= lca; i--) {
      const node = getNodeAtPath(this._root, currentPath.slice(0, i + 1));
      for (const fn of node.exit) ctx = fn(ctx, event) ?? ctx;

      // Record history in parent
      if (i > 0) {
        const parent = getNodeAtPath(this._root, currentPath.slice(0, i));
        if (parent.history) parent.historyValue = currentPath[i];
      }
    }

    // Transition actions
    for (const fn of transActions) ctx = fn(ctx, event) ?? ctx;

    // Entry from LCA down to target
    for (let i = lca; i < targetPath.length; i++) {
      const node = getNodeAtPath(this._root, targetPath.slice(0, i + 1));
      for (const fn of node.entry) ctx = fn(ctx, event) ?? ctx;
    }

    this._ctx = ctx;

    // Expand target compound state to leaf
    const { path, ctx: finalCtx } = expandToLeaf(this._root, targetPath, ctx, event);
    this._path = path;
    this._ctx = finalCtx;
  }
}

// ── HSM factory ───────────────────────────────────────────────────────────────

export class HSM<Ctx> {
  private readonly _root: StateNode<Ctx>;
  private readonly _initial: string;
  private readonly _initialCtx: Ctx;

  constructor(config: HSMConfig<Ctx>) {
    this._root = buildNode<Ctx>("__root__", { states: config.states } as StateConfig<Ctx>);
    this._initialCtx = (config.context ?? ({} as unknown as Ctx));
    this._initial = config.initial;
  }

  private _resolveInitialPath(root: StateNode<Ctx>, initial: string): string[] {
    const basePath = resolvePath(initial);
    let p: string[] = [];
    let node = root;
    for (const id of basePath) {
      const child = node.children.get(id);
      if (!child) throw new HSMError(`Initial state "${id}" not found`);
      node = child;
      p.push(id);
    }
    // Expand to leaf via initial chain
    while (node.children.size > 0) {
      if (!node.initial) throw new HSMError(`Compound state "${p.join(".")}" has no initial substate`);
      const childId = node.initial;
      node = node.children.get(childId)!;
      p.push(childId);
    }
    return p;
  }

  /**
   * Start the machine and run entry actions for the initial state path.
   * Returns the running service.
   */
  start(): HSMService<Ctx> {
    const initialPath = this._resolveInitialPath(this._root, this._initial);
    let ctx = this._initialCtx;
    const event: HSMEvent = { type: "__init__" };

    // Run entry actions down to initial leaf
    for (let i = 0; i < initialPath.length; i++) {
      const node = getNodeAtPath(this._root, initialPath.slice(0, i + 1));
      for (const fn of node.entry) ctx = fn(ctx, event) ?? ctx;
    }

    return new HSMService<Ctx>(this._root, [...initialPath], ctx);
  }
}

/**
 * Create a hierarchical state machine.
 *
 * @example
 * const machine = createHSM({
 *   initial: 'idle',
 *   context: { count: 0 },
 *   states: {
 *     idle: { on: { START: 'active' } },
 *     active: {
 *       initial: 'running',
 *       states: {
 *         running: { on: { PAUSE: 'active.paused', STOP: 'idle' } },
 *         paused:  { on: { RESUME: 'active.running', STOP: 'idle' } },
 *       },
 *     },
 *   },
 * });
 * const service = machine.start();
 */
export function createHSM<Ctx = Record<string, unknown>>(config: HSMConfig<Ctx>): HSM<Ctx> {
  return new HSM(config);
}
