import type { InboundJob } from "../queue/index.ts";

export type Reducer = (job: InboundJob) => Promise<void>;

/** Where later tasks register reducers. An exact event wins; `*` is the per-source fallback. */
export class EventRouter {
  #reducers = new Map<string, Reducer[]>();

  on(source: "plane" | "github", event: string, reducer: Reducer): void {
    const key = `${source}:${event}`;
    const list = this.#reducers.get(key) ?? [];
    list.push(reducer);
    this.#reducers.set(key, list);
  }

  async dispatch(job: InboundJob): Promise<"routed" | "unhandled"> {
    const list = this.#reducers.get(`${job.source}:${job.event}`) ?? this.#reducers.get(`${job.source}:*`);
    if (!list || list.length === 0) return "unhandled";
    for (const reducer of list) await reducer(job);
    return "routed";
  }
}
