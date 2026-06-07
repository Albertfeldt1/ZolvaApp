-- Widen icloud_proxy_calls.op CHECK to include the new 'search' op.
--
-- imap-proxy gained a full-text INBOX search op (IMAP SEARCH TEXT) so chat
-- can find a mail by sender/subject/body instead of only scanning the newest
-- N. The rate-limit + audit insert writes op='search'; without this the insert
-- trips the CHECK and checkRateLimit fails open - search would run unlimited
-- and untracked in the success-rate view. 'search' shares the list-inbox rate
-- bucket (both are read-only INBOX taps).
ALTER TABLE public.icloud_proxy_calls
  DROP CONSTRAINT IF EXISTS icloud_proxy_calls_op_check;

ALTER TABLE public.icloud_proxy_calls
  ADD CONSTRAINT icloud_proxy_calls_op_check
  CHECK (op IN (
    'validate',
    'list-inbox',
    'search',
    'get-body',
    'count',
    'clear-binding',
    'send-mail',
    'append-draft'
  ));
