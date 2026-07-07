// Papir → App.tsx overlay bridge.
//
// The iCloud-setup and Microsoft-admin-consent screens are App-level session
// overlays (they render over BOTH UIs since the K1 fix), but their open-state
// lives in App.tsx. Classic Settings receives opener props; Papir screens sit
// behind their own shell and can't be prop-drilled from App without threading
// callbacks through PapirRoot → PapirShell → push screens. Same module-store
// pattern as papir-flag / requestHistorySegment instead: Papir requests, App
// subscribes.
export type AppOverlayRequest =
  | { kind: 'icloud-setup'; prefilledEmail?: string }
  | { kind: 'admin-consent'; prefilledEmail?: string };

let listener: ((req: AppOverlayRequest) => void) | null = null;
let pending: AppOverlayRequest | null = null;

/** App.tsx registers exactly one handler at boot. A request fired before
 * registration (unlikely — App mounts first) is delivered on subscribe. */
export function subscribeAppOverlays(fn: (req: AppOverlayRequest) => void): () => void {
  listener = fn;
  if (pending) {
    const p = pending;
    pending = null;
    fn(p);
  }
  return () => {
    if (listener === fn) listener = null;
  };
}

export function requestAppOverlay(req: AppOverlayRequest): void {
  if (listener) listener(req);
  else pending = req;
}
