import { createHSM, HSMError } from "../src/index.js";

// ── 1. flat FSM ─────────────────────────────────────────────────────────────

describe("flat FSM", () => {
  const machine = createHSM({
    initial: "idle",
    states: {
      idle: { on: { START: "active" } },
      active: { on: { STOP: "idle" } },
    },
  });

  test("starts in initial state", () => {
    const s = machine.start();
    expect(s.state).toBe("idle");
  });

  test("transitions on event", () => {
    const s = machine.start();
    s.send("START");
    expect(s.state).toBe("active");
  });

  test("unknown event is ignored", () => {
    const s = machine.start();
    s.send("UNKNOWN");
    expect(s.state).toBe("idle");
  });

  test("chaining send", () => {
    const s = machine.start();
    s.send("START").send("STOP");
    expect(s.state).toBe("idle");
  });
});

// ── 2. compound states ───────────────────────────────────────────────────────

describe("compound states", () => {
  const machine = createHSM({
    initial: "idle",
    states: {
      idle: { on: { ACTIVATE: "active" } },
      active: {
        initial: "running",
        states: {
          running: { on: { PAUSE: "active.paused", STOP: "idle" } },
          paused:  { on: { RESUME: "active.running", STOP: "idle" } },
        },
      },
    },
  });

  test("enters compound initial substate", () => {
    const s = machine.start();
    s.send("ACTIVATE");
    expect(s.state).toBe("active.running");
  });

  test("transitions within compound state", () => {
    const s = machine.start();
    s.send("ACTIVATE").send("PAUSE");
    expect(s.state).toBe("active.paused");
  });

  test("exits compound state on outer event", () => {
    const s = machine.start();
    s.send("ACTIVATE").send("STOP");
    expect(s.state).toBe("idle");
  });

  test("event handled by parent if child has no handler", () => {
    const machine2 = createHSM({
      initial: "a",
      states: {
        a: {
          initial: "a1",
          on: { RESET: "a" },   // parent handles RESET
          states: {
            a1: { on: { GO: "a.a2" } },
            a2: {},
          },
        },
      },
    });
    const s = machine2.start();
    s.send("GO");
    expect(s.state).toBe("a.a2");
    s.send("RESET");
    expect(s.state).toBe("a.a1");  // re-enters initial
  });
});

// ── 3. matches() ─────────────────────────────────────────────────────────────

describe("matches()", () => {
  const machine = createHSM({
    initial: "active",
    states: {
      active: {
        initial: "running",
        states: {
          running: {},
          paused: {},
        },
      },
    },
  });

  test("exact match", () => {
    const s = machine.start();
    expect(s.matches("active.running")).toBe(true);
  });

  test("prefix match (parent state)", () => {
    const s = machine.start();
    expect(s.matches("active")).toBe(true);
  });

  test("non-match", () => {
    const s = machine.start();
    expect(s.matches("active.paused")).toBe(false);
    expect(s.matches("idle")).toBe(false);
  });
});

// ── 4. entry / exit actions ──────────────────────────────────────────────────

describe("entry and exit actions", () => {
  test("entry called on initial state", () => {
    const log: string[] = [];
    const machine = createHSM({
      initial: "a",
      states: {
        a: { entry: () => { log.push("entry:a"); } },
      },
    });
    machine.start();
    expect(log).toEqual(["entry:a"]);
  });

  test("entry and exit called in correct order on transition", () => {
    const log: string[] = [];
    const machine = createHSM({
      initial: "a",
      states: {
        a: {
          entry: () => log.push("entry:a"),
          exit:  () => log.push("exit:a"),
          on: { GO: "b" },
        },
        b: {
          entry: () => log.push("entry:b"),
          exit:  () => log.push("exit:b"),
        },
      },
    });
    const s = machine.start();
    log.length = 0;  // clear init entry
    s.send("GO");
    expect(log).toEqual(["exit:a", "entry:b"]);
  });

  test("compound state — exit leaf then parent, enter parent then leaf", () => {
    const log: string[] = [];
    const machine = createHSM({
      initial: "active",
      states: {
        idle: { entry: () => log.push("entry:idle") },
        active: {
          entry: () => log.push("entry:active"),
          exit:  () => log.push("exit:active"),
          initial: "running",
          states: {
            running: {
              entry: () => log.push("entry:running"),
              exit:  () => log.push("exit:running"),
              on: { STOP: "idle" },
            },
          },
        },
      },
    });
    log.length = 0;
    const s = machine.start();
    // init: entry:active → entry:running
    expect(log).toEqual(["entry:active", "entry:running"]);
    log.length = 0;
    s.send("STOP");
    // exit running → exit active → entry idle
    expect(log).toEqual(["exit:running", "exit:active", "entry:idle"]);
  });

  test("intra-compound transition only exits/enters changed nodes", () => {
    const log: string[] = [];
    const machine = createHSM({
      initial: "active",
      states: {
        active: {
          entry: () => log.push("entry:active"),
          exit:  () => log.push("exit:active"),
          initial: "s1",
          states: {
            s1: {
              entry: () => log.push("entry:s1"),
              exit:  () => log.push("exit:s1"),
              on: { NEXT: "active.s2" },
            },
            s2: {
              entry: () => log.push("entry:s2"),
              exit:  () => log.push("exit:s2"),
            },
          },
        },
      },
    });
    log.length = 0;
    const s = machine.start();
    expect(log).toEqual(["entry:active", "entry:s1"]);
    log.length = 0;
    s.send("NEXT");
    // Only s1 exits, s2 enters — active stays (it's LCA)
    expect(log).toEqual(["exit:s1", "entry:s2"]);
    expect(log).not.toContain("exit:active");
  });
});

// ── 5. guards ────────────────────────────────────────────────────────────────

describe("guards", () => {
  test("allows transition when guard returns true", () => {
    const machine = createHSM({
      initial: "idle",
      context: { authorized: true },
      states: {
        idle: {
          on: {
            START: [{
              target: "active",
              guard: (ctx: { authorized: boolean }) => ctx.authorized,
            }],
          },
        },
        active: {},
      },
    });
    const s = machine.start();
    s.send("START");
    expect(s.state).toBe("active");
  });

  test("blocks transition when guard returns false", () => {
    const machine = createHSM({
      initial: "idle",
      context: { authorized: false },
      states: {
        idle: {
          on: {
            START: [{
              target: "active",
              guard: (ctx: { authorized: boolean }) => ctx.authorized,
            }],
          },
        },
        active: {},
      },
    });
    const s = machine.start();
    s.send("START");
    expect(s.state).toBe("idle");
  });

  test("falls through to next transition when guard fails", () => {
    const machine = createHSM({
      initial: "idle",
      context: { level: 0 },
      states: {
        idle: {
          on: {
            UPGRADE: [
              { target: "admin",  guard: (ctx: { level: number }) => ctx.level >= 10 },
              { target: "user",   guard: (ctx: { level: number }) => ctx.level >= 1  },
              { target: "guest" },
            ],
          },
        },
        admin: {}, user: {}, guest: {},
      },
    });
    expect(machine.start().send("UPGRADE").state).toBe("guest");

    const m2 = createHSM({
      initial: "idle",
      context: { level: 5 },
      states: {
        idle: {
          on: {
            UPGRADE: [
              { target: "admin",  guard: (ctx: { level: number }) => ctx.level >= 10 },
              { target: "user",   guard: (ctx: { level: number }) => ctx.level >= 1  },
              { target: "guest" },
            ],
          },
        },
        admin: {}, user: {}, guest: {},
      },
    });
    expect(m2.start().send("UPGRADE").state).toBe("user");
  });
});

// ── 6. context ───────────────────────────────────────────────────────────────

describe("context", () => {
  test("actions can update context", () => {
    const machine = createHSM({
      initial: "idle",
      context: { count: 0 },
      states: {
        idle: {
          on: {
            INC: [{
              target: undefined,   // internal transition
              actions: [(ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 })],
            }],
          },
        },
      },
    });
    const s = machine.start();
    s.send("INC").send("INC").send("INC");
    expect(s.context.count).toBe(3);
  });

  test("transition actions run with updated context", () => {
    const machine = createHSM({
      initial: "idle",
      context: { entered: false },
      states: {
        idle: { on: { GO: "active" } },
        active: {
          entry: (ctx: { entered: boolean }) => ({ ...ctx, entered: true }),
        },
      },
    });
    const s = machine.start();
    s.send("GO");
    expect(s.context.entered).toBe(true);
  });

  test("event payload accessible in actions", () => {
    const machine = createHSM({
      initial: "idle",
      context: { value: 0 },
      states: {
        idle: {
          on: {
            SET: [{
              actions: [(ctx: { value: number }, evt) => ({ ...ctx, value: evt.payload as number })],
            }],
          },
        },
      },
    });
    const s = machine.start();
    s.send("SET", { payload: 42 });
    expect(s.context.value).toBe(42);
  });
});

// ── 7. internal transitions ──────────────────────────────────────────────────

describe("internal transitions", () => {
  test("no exit/entry on internal transition", () => {
    const log: string[] = [];
    const machine = createHSM({
      initial: "active",
      states: {
        active: {
          entry: () => log.push("entry"),
          exit:  () => log.push("exit"),
          on: {
            TICK: [{ actions: [(ctx: unknown, e) => { log.push(`tick:${e.n}`); }] }],
          },
        },
      },
    });
    log.length = 0;
    const s = machine.start();
    expect(log).toEqual(["entry"]);
    s.send("TICK", { n: 1 });
    expect(log).toEqual(["entry", "tick:1"]);
    expect(s.state).toBe("active");
  });
});

// ── 8. history ───────────────────────────────────────────────────────────────

describe("shallow history", () => {
  const machine = createHSM({
    initial: "idle",
    states: {
      idle: { on: { RESUME: "active" } },
      active: {
        history: true,
        initial: "s1",
        on: { INTERRUPT: "idle" },
        states: {
          s1: { on: { NEXT: "active.s2" } },
          s2: { on: { NEXT: "active.s3" } },
          s3: {},
        },
      },
    },
  });

  test("without history — always enters initial", () => {
    const s = machine.start();
    s.send("RESUME").send("NEXT").send("INTERRUPT").send("RESUME");
    // after interrupt + resume: history=true so should return to s2
    expect(s.state).toBe("active.s2");
  });

  test("remembers last visited substate", () => {
    const s = machine.start();
    s.send("RESUME").send("NEXT").send("NEXT");  // now at s3
    expect(s.state).toBe("active.s3");
    s.send("INTERRUPT").send("RESUME");
    expect(s.state).toBe("active.s3");
  });
});

// ── 9. subscribe ─────────────────────────────────────────────────────────────

describe("subscribe", () => {
  test("listener called on each transition", () => {
    const machine = createHSM({
      initial: "a",
      states: {
        a: { on: { GO: "b" } },
        b: { on: { BACK: "a" } },
      },
    });
    const log: string[] = [];
    const s = machine.start();
    const unsub = s.subscribe((state) => log.push(state));
    s.send("GO").send("BACK");
    expect(log).toEqual(["b", "a"]);
    unsub();
    s.send("GO");
    expect(log).toEqual(["b", "a"]);  // not called after unsub
  });

  test("listener receives event", () => {
    const machine = createHSM({
      initial: "a",
      states: { a: { on: { PING: "a" } } },
    });
    const events: string[] = [];
    const s = machine.start();
    s.subscribe((_, __, e) => events.push(e.type));
    s.send("PING");
    expect(events).toContain("PING");
  });
});

// ── 10. stateValue ────────────────────────────────────────────────────────────

describe("stateValue", () => {
  test("returns array of path segments", () => {
    const machine = createHSM({
      initial: "a",
      states: {
        a: { initial: "b", states: { b: { initial: "c", states: { c: {} } } } },
      },
    });
    const s = machine.start();
    expect(s.stateValue).toEqual(["a", "b", "c"]);
  });
});

// ── 11. HSMError ──────────────────────────────────────────────────────────────

describe("HSMError", () => {
  test("thrown on missing initial substate", () => {
    const machine = createHSM({
      initial: "a",
      states: {
        a: { states: { b: {} } },  // no `initial`
      },
    });
    expect(() => machine.start()).toThrow(HSMError);
  });
});

// ── 12. practical: traffic light ─────────────────────────────────────────────

describe("traffic light example", () => {
  const light = createHSM({
    initial: "green",
    context: { count: 0 },
    states: {
      green:  { on: { NEXT: "yellow" }, entry: (ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 }) },
      yellow: { on: { NEXT: "red" } },
      red:    { on: { NEXT: "green" } },
    },
  });

  test("cycles through states", () => {
    const s = light.start();
    expect(s.state).toBe("green");
    s.send("NEXT");
    expect(s.state).toBe("yellow");
    s.send("NEXT");
    expect(s.state).toBe("red");
    s.send("NEXT");
    expect(s.state).toBe("green");
  });

  test("counts green entries", () => {
    const s = light.start();
    // starts in green (+1), cycles back to green (+1 more)
    s.send("NEXT").send("NEXT").send("NEXT");
    expect(s.context.count).toBe(2);
  });
});

// ── 13. practical: vending machine ───────────────────────────────────────────

describe("vending machine example", () => {
  const vm = createHSM({
    initial: "idle",
    context: { coins: 0 },
    states: {
      idle: {
        on: {
          INSERT_COIN: [{
            actions: [(ctx: { coins: number }) => ({ ...ctx, coins: ctx.coins + 25 })],
          }],
          SELECT: [{
            target: "dispensing",
            guard: (ctx: { coins: number }) => ctx.coins >= 75,
          }],
        },
      },
      dispensing: {
        entry: (ctx: { coins: number }) => ({ ...ctx, coins: ctx.coins - 75 }),
        on: { DONE: "idle" },
      },
    },
  });

  test("requires enough coins before dispensing", () => {
    const s = vm.start();
    s.send("SELECT");
    expect(s.state).toBe("idle");
    s.send("INSERT_COIN").send("INSERT_COIN").send("INSERT_COIN");
    expect(s.context.coins).toBe(75);
    s.send("SELECT");
    expect(s.state).toBe("dispensing");
    expect(s.context.coins).toBe(0);
  });
});
