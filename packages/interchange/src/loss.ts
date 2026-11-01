export interface LossItem { feature: string; detail: string; severity: 'lost' | 'approximated' | 'preserved-as-metadata' }
/** Every adapter returns this next to its output. Nothing is dropped silently. */
export interface LossReport { format: string; items: LossItem[] }
export const lossText = (r: LossReport) => r.items.map((i) => `[${i.severity}] ${i.feature}: ${i.detail}`).join('\n');
