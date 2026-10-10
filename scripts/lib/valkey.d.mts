export interface ThrowawayValkey { url: string; port: number; stop(): Promise<void> }
export function startValkey(): Promise<ThrowawayValkey>;
