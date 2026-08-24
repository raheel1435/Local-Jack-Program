export type ReleaseAdmission = () => void;

interface Waiter {
  resolve: (release: ReleaseAdmission | null) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Small bounded FIFO admission gate for expensive local-native work. */
export class AdmissionGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly activeLimit: number,
    readonly waitingLimit: number,
  ) {
    if (!Number.isInteger(activeLimit) || activeLimit < 1) throw new Error("activeLimit must be positive");
    if (!Number.isInteger(waitingLimit) || waitingLimit < 0) throw new Error("waitingLimit must be non-negative");
  }

  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.waiters.length; }

  tryAcquire(): ReleaseAdmission | null {
    if (this.active >= this.activeLimit) return null;
    this.active++;
    return this.createRelease();
  }

  acquire(signal?: AbortSignal): Promise<ReleaseAdmission | null> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted || this.waiters.length >= this.waitingLimit) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private createRelease(): ReleaseAdmission {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.active++;
      waiter.resolve(this.createRelease());
    };
  }
}
