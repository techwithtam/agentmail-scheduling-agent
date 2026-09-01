import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue";

describe("SerialTaskQueue", () => {
  it("does not start a second task until the first one finishes", async () => {
    const queue = new SerialTaskQueue();
    const steps: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      steps.push("first:start");
      await firstGate;
      steps.push("first:end");
    });
    const second = queue.run(async () => {
      steps.push("second:start");
      steps.push("second:end");
    });

    await Promise.resolve();
    expect(steps).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(steps).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues with the next task after a rejection", async () => {
    const queue = new SerialTaskQueue();
    const first = queue.run(async () => { throw new Error("failed"); });
    const second = queue.run(async () => "completed");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("completed");
  });
});
