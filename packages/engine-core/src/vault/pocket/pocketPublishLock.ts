/**
 * Serializes every Pocket publish AND revoke attempt within this process.
 *
 * Why a lock at all: a publish has real `await` points (the Drive upload),
 * during which the Node event loop can run another handler — a second
 * "Publicar ahora" click, the debounce timer firing, or a revoke — so two
 * publishes (or a publish racing a revoke) are a genuine possible
 * interleaving, not just a theoretical one. Serializing both through this
 * one queue gives two guarantees for free: (1) two concurrent publish calls
 * can never race the same revision number, since the second one only starts
 * once the first has fully finished (and by then a no-op "not dirty" check
 * at the top of the publish makes it cheap); (2) a revoke can never let a
 * publish that started before it slip through using the OLD Pocket DEK
 * after the revoke has "committed" — the revoke simply waits its turn.
 */
let queue: Promise<unknown> = Promise.resolve();

export function withPocketLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  // Swallow so one failed turn never poisons the queue for the next caller.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
