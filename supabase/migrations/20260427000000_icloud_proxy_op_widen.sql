-- Widen icloud_proxy_calls.op CHECK to include the get-body and clear-binding
-- operations. The original constraint predates these ops, so every rate-limit
-- accounting insert for them silently 400'd, leaving get-body effectively
-- unrate-limited (count always read 0).
ALTER TABLE public.icloud_proxy_calls
  DROP CONSTRAINT IF EXISTS icloud_proxy_calls_op_check;

ALTER TABLE public.icloud_proxy_calls
  ADD CONSTRAINT icloud_proxy_calls_op_check
  CHECK (op IN ('validate', 'list-inbox', 'get-body', 'clear-binding'));
