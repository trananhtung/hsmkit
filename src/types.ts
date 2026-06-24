export type EventType = string;
export type StateId = string;

export interface HSMEvent {
  type: EventType;
  [key: string]: unknown;
}

export type ActionFn<Ctx> = (ctx: Ctx, event: HSMEvent) => Ctx | void;
export type GuardFn<Ctx> = (ctx: Ctx, event: HSMEvent) => boolean;

export interface TransitionConfig<Ctx> {
  target?: string;   // undefined = internal transition (no exit/entry)
  guard?: GuardFn<Ctx>;
  actions?: ActionFn<Ctx>[];
}

export interface StateConfig<Ctx> {
  initial?: string;
  type?: "compound" | "atomic";
  states?: Record<string, StateConfig<Ctx>>;
  on?: Record<string, string | TransitionConfig<Ctx> | Array<TransitionConfig<Ctx>>>;
  entry?: ActionFn<Ctx> | ActionFn<Ctx>[];
  exit?: ActionFn<Ctx> | ActionFn<Ctx>[];
  history?: boolean;   // shallow history — remember last active child
}

export interface HSMConfig<Ctx> {
  initial: string;
  context?: Ctx;
  states: Record<string, StateConfig<Ctx>>;
}

export type StateListener<Ctx> = (
  state: string,
  ctx: Ctx,
  event: HSMEvent,
) => void;
