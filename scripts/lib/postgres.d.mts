export interface ThrowawayPostgres { url: string; port: number; stop(): Promise<void> }
export function startPostgres(): Promise<ThrowawayPostgres>;
