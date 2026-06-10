// Verdict returned by a rail. ok=false means "not safe" → caller degrades to
// propose / taints the run. category/reason are for logging only.
export interface GuardrailVerdict {
  ok: boolean;
  category: string;
  reason: string;
}

// Raw result of a single classifier call (post-parse).
export interface ClassifierResult {
  verdict: 'safe' | 'unsafe';
  category: string;
}

// Injected classifier. `surface` tags usage (e.g. 'guardrail-input').
// Implementations MUST resolve; throwing is allowed and is treated by the
// rails as fail-safe (unsafe).
export type GuardrailClassifier = (args: {
  system: string;
  user: string;
  surface: string;
}) => Promise<ClassifierResult>;
