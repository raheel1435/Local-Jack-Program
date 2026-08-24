import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionGate } from "./admission.ts";

test("AdmissionGate enforces active and waiting limits and releases FIFO", async () => {
  const gate = new AdmissionGate(1, 1);
  const first = gate.tryAcquire();
  assert.ok(first);
  const waiting = gate.acquire();
  assert.equal(await gate.acquire(), null);
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.waitingCount, 1);
  first();
  const second = await waiting;
  assert.ok(second);
  assert.equal(gate.activeCount, 1);
  second();
  second();
  assert.equal(gate.activeCount, 0);
});

test("AdmissionGate removes an aborted waiter", async () => {
  const gate = new AdmissionGate(1, 1);
  const release = gate.tryAcquire();
  const abort = new AbortController();
  const waiting = gate.acquire(abort.signal);
  abort.abort();
  assert.equal(await waiting, null);
  assert.equal(gate.waitingCount, 0);
  release?.();
});
