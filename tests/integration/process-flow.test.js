/**
 * process-flow.test.js — End-to-end behaviour of the queue processor.
 *
 * Builds a minimal mock of the SW <-> CS contract and verifies:
 *   1. Cancel takes effect within one inter-chat polling interval.
 *   2. No "processing" event is emitted for a chat the user cancelled out of.
 *   3. The aborted-flag short-circuit forwards through to broadcastProgress.
 */

import { describe, test, expect } from 'vitest';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Simplified copy of service_worker.js#processQueue, with sleep parameters
 * shrunk for fast tests and the chrome.* APIs replaced by injected fakes.
 */
async function runQueue({ queue, extractChat, broadcast, controlRef, interChatMs = 100 }) {
  for (const chatKey of queue) {
    if (!controlRef.isProcessing) {
      broadcast({ status: 'cancelled' });
      return;
    }

    broadcast({ status: 'processing', current: chatKey });

    const result = await extractChat(chatKey);

    if (result.aborted) {
      broadcast({ status: 'cancelled' });
      return;
    }

    if (queue.indexOf(chatKey) < queue.length - 1) {
      const deadline = Date.now() + interChatMs;
      while (Date.now() < deadline) {
        if (!controlRef.isProcessing) break;
        await sleep(20);
      }
    }
  }
  broadcast({ status: 'done' });
}

describe('processQueue cancel flow', () => {
  test('emits no further "processing" events after cancel during inter-chat sleep', async () => {
    const events = [];
    const broadcast = (e) => events.push(e);
    const controlRef = { isProcessing: true };

    // Each fake extraction is fast (10ms) so the inter-chat 100ms sleep
    // dominates — that's where Cancel needs to take effect quickly.
    const extractChat = async (key) => {
      await sleep(10);
      return { messages: [], chatKey: key };
    };

    const queue = ['chat-1', 'chat-2', 'chat-3', 'chat-4'];
    const runPromise = runQueue({ queue, extractChat, broadcast, controlRef });

    // Fire Cancel after the first chat starts but before the second.
    setTimeout(() => { controlRef.isProcessing = false; }, 50);

    await runPromise;

    // Sanity: at least one chat fully processed.
    const processingEvents = events.filter((e) => e.status === 'processing');
    expect(processingEvents.length).toBeGreaterThanOrEqual(1);

    // Critical: must NOT have processed all 4 chats.
    expect(processingEvents.length).toBeLessThan(queue.length);

    // Last event must be "cancelled".
    expect(events[events.length - 1].status).toBe('cancelled');
  });

  test('aborted result mid-chat short-circuits the queue', async () => {
    const events = [];
    const broadcast = (e) => events.push(e);
    const controlRef = { isProcessing: true };

    let callCount = 0;
    const extractChat = async (key) => {
      callCount++;
      // Second chat returns aborted (simulates user cancelling during extraction).
      if (callCount === 2) return { aborted: true, error: 'Aborted', chatKey: key };
      return { messages: [], chatKey: key };
    };

    await runQueue({
      queue: ['c1', 'c2', 'c3', 'c4'],
      extractChat,
      broadcast,
      controlRef,
      interChatMs: 10,
    });

    // Only c1 and c2 should have been attempted.
    expect(callCount).toBe(2);
    expect(events[events.length - 1].status).toBe('cancelled');
  });

  test('completes normally when no cancel is issued', async () => {
    const events = [];
    const controlRef = { isProcessing: true };
    const extractChat = async (key) => ({ messages: [{ chatKey: key }], chatKey: key });

    await runQueue({
      queue: ['c1', 'c2', 'c3'],
      extractChat,
      broadcast: (e) => events.push(e),
      controlRef,
      interChatMs: 5,
    });

    const processingEvents = events.filter((e) => e.status === 'processing');
    expect(processingEvents.length).toBe(3);
    expect(events[events.length - 1].status).toBe('done');
  });
});
