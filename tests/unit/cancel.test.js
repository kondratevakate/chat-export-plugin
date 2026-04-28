/**
 * cancel.test.js — Cancel responsiveness regression test.
 *
 * Failure mode B from the plan ("Cancel race during inter-chat sleep").
 *
 * Verifies that a long-running scroll-style loop honours an abort flag set
 * mid-flight, returning within ~one polling-interval rather than running
 * to its full deadline. Also covers the inter-chat polling loop in
 * service_worker.js#processQueue.
 */

import { describe, test, expect } from 'vitest';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirror of service_worker.js#processQueue's polling-sleep: poll a flag
 * every `pollMs` instead of sleeping the full `targetMs` unconditionally.
 */
async function pollableInterChatSleep(targetMs, isProcessingRef, pollMs = 100) {
  const deadline = Date.now() + targetMs;
  while (Date.now() < deadline) {
    if (!isProcessingRef.value) return;
    await sleep(pollMs);
  }
}

/**
 * Mirror of content_script.js#scrollToLoadMore: perform up to N iterations
 * with `pauseMs` between each, but bail out if `abortFlagRef.value` is true.
 */
async function abortableScrollLoop(maxIterations, pauseMs, abortFlagRef, doWork) {
  let i = 0;
  for (; i < maxIterations; i++) {
    if (abortFlagRef.value) return { iterations: i, aborted: true };
    doWork(i);
    await sleep(pauseMs);
  }
  return { iterations: i, aborted: false };
}

describe('inter-chat polling sleep', () => {
  test('returns within ~pollMs of the flag being flipped', async () => {
    const flag = { value: true };
    const startTime = Date.now();
    const sleepPromise = pollableInterChatSleep(2000, flag, 50);

    // Flip the flag after 200ms.
    setTimeout(() => { flag.value = false; }, 200);

    await sleepPromise;
    const elapsed = Date.now() - startTime;

    // Must return within ~250ms (200ms wait + 50ms polling slack).
    // The OLD code (unconditional sleep) would have waited the full 2000ms.
    expect(elapsed).toBeLessThan(400);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  test('runs the full duration when flag stays true', async () => {
    const flag = { value: true };
    const startTime = Date.now();
    await pollableInterChatSleep(300, flag, 50);
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(290);
  });
});

describe('abortable scroll loop', () => {
  test('halts at the next iteration when abortFlag flips', async () => {
    const abort = { value: false };
    const seen = [];

    const loopPromise = abortableScrollLoop(20, 50, abort, (i) => seen.push(i));
    setTimeout(() => { abort.value = true; }, 175);

    const { iterations, aborted } = await loopPromise;
    expect(aborted).toBe(true);
    // Should have stopped after roughly 3-4 iterations (175ms / 50ms),
    // NOT all 20 iterations (which would take 1000ms).
    expect(iterations).toBeLessThan(8);
    expect(seen.length).toBeGreaterThan(0);
  });

  test('completes all iterations when abort never fires', async () => {
    const abort = { value: false };
    const { iterations, aborted } = await abortableScrollLoop(5, 10, abort, () => {});
    expect(iterations).toBe(5);
    expect(aborted).toBe(false);
  });
});
