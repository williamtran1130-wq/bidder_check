export type ReadSeed<T> = {
  key: string;
  receivedAt?: number;
  result: { data?: T; error?: string; code?: string };
};
export function readKey(
  scope: string,
  operation: string,
  query: unknown,
  day: string,
) {
  return JSON.stringify([scope, operation, query, day]);
}
export function seedFor<T>(key: string, seed?: ReadSeed<T>) {
  return seed?.key === key ? seed.result : undefined;
}
type RequestTicket<T> = {
  key: string;
  generation: number;
  promise: Promise<T>;
};
/** Per-consumer lifetime; never a process-wide private server cache. */
export class ReadRequests<T> {
  private generation = 0;
  private pending = new Map<string, RequestTicket<T>>();
  invalidate() {
    this.generation++;
    this.pending.clear();
  }
  current(ticket: RequestTicket<T>) {
    return ticket.generation === this.generation;
  }
  load(key: string, run: () => Promise<T>): RequestTicket<T> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const ticket = {
      key,
      generation: this.generation,
      promise: Promise.resolve().then(run),
    };
    this.pending.set(key, ticket);
    const finish = () => {
      if (this.pending.get(key) === ticket) this.pending.delete(key);
    };
    void ticket.promise.then(finish, finish);
    return ticket;
  }
}
