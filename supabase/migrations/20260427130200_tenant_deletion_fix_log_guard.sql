create or replace function public.purge_tenant_data(
  p_tenant_id text,
  p_requested_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_user_ids uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_count int;
begin
  if p_tenant_id is null or length(p_tenant_id) = 0 then
    raise exception 'purge_tenant_data: tenant_id is required';
  end if;
  if p_requested_by is null or length(p_requested_by) = 0 then
    raise exception 'purge_tenant_data: requested_by is required';
  end if;
  if p_tenant_id = '9188040d-6c67-4c5b-b112-36a304b66dad' then
    -- Log the attempt before raising — someone tried to delete the consumer
    -- tenant, that's a forensic event worth recording.
    insert into public.tenant_deletion_log (tenant_id, requested_by, started_at, completed_at, affected_user_ids, rows_deleted, error)
    values (p_tenant_id, p_requested_by, v_started_at, clock_timestamp(),
            array[]::uuid[], '{}'::jsonb,
            'refused: Microsoft consumer tenant');
    raise exception 'purge_tenant_data: refusing to delete the Microsoft consumer tenant';
  end if;

  select coalesce(array_agg(distinct user_id), array[]::uuid[])
    into v_user_ids
    from public.integrations
    where tenant_id = p_tenant_id;

  if array_length(v_user_ids, 1) is null then
    insert into public.tenant_deletion_log (tenant_id, requested_by, started_at, completed_at, affected_user_ids, rows_deleted)
    values (p_tenant_id, p_requested_by, v_started_at, clock_timestamp(),
            array[]::uuid[], jsonb_build_object('note', 'no users found for tenant'));
    return jsonb_build_object('status', 'no-users', 'tenant_id', p_tenant_id);
  end if;

  delete from public.icloud_proxy_calls         where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('icloud_proxy_calls', v_count);
  delete from public.icloud_credential_bindings where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('icloud_credential_bindings', v_count);
  delete from public.observations               where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('observations', v_count);
  delete from public.facts                      where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('facts', v_count);
  delete from public.mail_events                where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('mail_events', v_count);
  delete from public.chat_messages              where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('chat_messages', v_count);
  delete from public.briefs                     where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('briefs', v_count);
  delete from public.claude_usage_buckets       where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('claude_usage_buckets', v_count);
  delete from public.work_preferences           where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('work_preferences', v_count);
  delete from public.user_profiles              where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('user_profiles', v_count);
  delete from public.user_settings              where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('user_settings', v_count);
  delete from public.user_email_domains         where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('user_email_domains', v_count);
  delete from public.user_oauth_tokens          where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('user_oauth_tokens', v_count);
  delete from public.integrations               where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('integrations', v_count);
  delete from public.mail_watchers              where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('mail_watchers', v_count);
  delete from public.push_tokens                where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('push_tokens', v_count);
  delete from public.push_subscriptions         where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('push_subscriptions', v_count);
  delete from public.notes                      where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('notes', v_count);
  delete from public.reminders                  where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('reminders', v_count);
  delete from public.messages                   where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('messages', v_count);
  delete from public.rate_limits                where user_id = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('rate_limits', v_count);
  delete from public.profiles                   where id      = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('profiles', v_count);
  delete from auth.users                        where id      = any(v_user_ids); get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('auth_users', v_count);

  insert into public.tenant_deletion_log (tenant_id, requested_by, started_at, completed_at, affected_user_ids, rows_deleted)
  values (p_tenant_id, p_requested_by, v_started_at, clock_timestamp(), v_user_ids, v_counts);

  return jsonb_build_object(
    'status', 'ok',
    'tenant_id', p_tenant_id,
    'affected_user_count', array_length(v_user_ids, 1),
    'rows_deleted', v_counts
  );
exception when others then
  -- Log the partial state ONLY if we got past arg validation (tenant_id
  -- and requested_by are both non-null and non-empty). Validation failures
  -- shouldn't write to the audit table — they're malformed calls, not
  -- deletion events.
  if p_tenant_id is not null and length(p_tenant_id) > 0
     and p_requested_by is not null and length(p_requested_by) > 0 then
    insert into public.tenant_deletion_log (tenant_id, requested_by, started_at, completed_at, affected_user_ids, rows_deleted, error)
    values (p_tenant_id, p_requested_by, v_started_at, clock_timestamp(),
            coalesce(v_user_ids, array[]::uuid[]), v_counts, sqlerrm);
  end if;
  raise;
end;
$$;
