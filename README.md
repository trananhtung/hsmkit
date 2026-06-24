# hsmkit

> Zero-dependency TypeScript hierarchical state machine (HSM/statecharts). Compound states, entry/exit actions, guards, shallow history, internal transitions. Port of Python `pytransitions` / C# `Stateless` / Ruby `AASM` — lighter than XState.

[![npm](https://img.shields.io/npm/v/hsmkit)](https://www.npmjs.com/package/hsmkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Install

```bash
npm install hsmkit
```

## Quick start

```typescript
import { createHSM } from "hsmkit";

const machine = createHSM({
  initial: "idle",
  context: { count: 0 },
  states: {
    idle: {
      on: { START: "active" },
    },
    active: {
      initial: "running",           // compound state
      entry: (ctx) => { console.log("entered active"); return ctx; },
      exit:  (ctx) => { console.log("exited active");  return ctx; },
      states: {
        running: {
          on: {
            PAUSE: "active.paused", // transition within compound state
            STOP:  "idle",          // exit compound state
          },
        },
        paused: {
          on: {
            RESUME: "active.running",
            STOP:   "idle",
          },
        },
      },
    },
  },
});

const service = machine.start();
service.state;              // "idle"
service.send("START");
service.state;              // "active.running"
service.send("PAUSE");
service.state;              // "active.paused"
service.matches("active");  // true — prefix match
service.send("STOP");
service.state;              // "idle"
```

## Why hsmkit?

| Library | Download/week | Last updated | Hierarchical? | Zero-dep? |
|---|---|---|---|---|
| XState | ~3M | Active | ✅ statecharts | ❌ (actor model) |
| `@steelbreeze/state` | ~344 | **March 2022** | ✅ | ✅ |
| `javascript-state-machine` | ~1.8M | **2021** | ❌ flat only | ✅ |
| **hsmkit** | — | **Active** | ✅ | ✅ |

XState is excellent but its v5 abstraction is the **actor model** — the right tool for distributed systems, not for a simple UI component or protocol parser. `hsmkit` gives you the core of Harel statecharts (the part that matters for most uses) in 0 dependencies.

## Features

- **Compound states** — states that contain child states (hierarchical nesting)
- **Entry/exit actions** — called at LCA-correct depth on every transition
- **Guards** — conditional transitions with fallthrough to next candidate
- **Shallow history** — remember last active substate across interruptions
- **Internal transitions** — actions without exit/entry (via `target: undefined`)
- **Event payload** — pass data with `service.send("EVT", { value: 42 })`
- **Mutable context** — return new context from actions
- **subscribe()** — listen to every state change; returns an unsubscribe function

## API

### `createHSM(config)`

```typescript
const machine = createHSM({
  initial: "idle",         // required: initial state (dot-notation for nested)
  context: { count: 0 },  // optional: initial context
  states: {               // state definitions
    idle: { ... },
    active: { ... },
  },
});
```

### `StateConfig`

```typescript
interface StateConfig<Ctx> {
  initial?: string;          // required for compound states
  states?: Record<string, StateConfig<Ctx>>;  // child states
  history?: boolean;         // shallow history (default: false)
  entry?: ActionFn<Ctx> | ActionFn<Ctx>[];
  exit?:  ActionFn<Ctx> | ActionFn<Ctx>[];
  on?: Record<string, TransitionTarget>;
}

// Transition targets:
"stateName"                          // simple target
"parent.child"                       // nested target (dot-notation)
{ target: "stateName", guard, actions }  // with guard/actions
[{ target, guard }, { target }]      // multiple candidates (fallthrough)
{ target: undefined, actions: [...] } // internal (no exit/entry)
```

### `HSMService`

```typescript
service.state         // string — e.g. "active.running"
service.stateValue    // string[] — e.g. ["active", "running"]
service.context       // current context
service.send(type, payload?)   // fire an event, returns this
service.matches(state)         // true if state is prefix of current path
service.subscribe(fn)          // returns unsub function
```

## Examples

### Guards with fallthrough

```typescript
const machine = createHSM({
  initial: "idle",
  context: { role: "guest" },
  states: {
    idle: {
      on: {
        ENTER: [
          { target: "admin",  guard: (ctx) => ctx.role === "admin" },
          { target: "user",   guard: (ctx) => ctx.role === "user"  },
          { target: "guest" },     // default — no guard
        ],
      },
    },
    admin: {}, user: {}, guest: {},
  },
});
```

### Shallow history — audio player

```typescript
const player = createHSM({
  initial: "idle",
  states: {
    idle: { on: { PLAY: "playing" } },
    playing: {
      history: true,         // remember last substate
      initial: "normal",
      on: { PAUSE_ALL: "idle" },
      states: {
        normal:  { on: { SHUFFLE: "playing.shuffle" } },
        shuffle: { on: { NORMAL: "playing.normal"  } },
      },
    },
  },
});

const s = player.start();
s.send("PLAY").send("SHUFFLE");  // playing.shuffle
s.send("PAUSE_ALL").send("PLAY"); // returns to playing.shuffle (history!)
```

### Internal transitions (no exit/entry)

```typescript
const machine = createHSM({
  initial: "active",
  context: { ticks: 0 },
  states: {
    active: {
      on: {
        TICK: [{
          // target: undefined — internal transition
          actions: [(ctx) => ({ ...ctx, ticks: ctx.ticks + 1 })],
        }],
      },
    },
  },
});
```

### Traffic light

```typescript
const light = createHSM({
  initial: "green",
  states: {
    green:  { on: { NEXT: "yellow" } },
    yellow: { on: { NEXT: "red"    } },
    red:    { on: { NEXT: "green"  } },
  },
});
const s = light.start();
s.send("NEXT").send("NEXT").send("NEXT");
s.state; // "green"
```

## Comparison

| Feature | `pytransitions` | C# `Stateless` | XState v5 | `hsmkit` |
|---|---|---|---|---|
| Compound states | ✅ | ✅ | ✅ | ✅ |
| Entry/exit actions | ✅ | ✅ | ✅ | ✅ |
| Guards | ✅ | ✅ | ✅ | ✅ |
| History | ✅ | ✅ | ✅ | ✅ (shallow) |
| Parallel regions | ✅ | ✅ | ✅ | ❌ (future) |
| Actor model | ❌ | ❌ | ✅ (v5) | ❌ |
| Zero dependencies | ✅ | ✅ | ❌ | ✅ |

## License

MIT © [trananhtung](https://github.com/trananhtung)
