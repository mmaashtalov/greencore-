-- Fleet MVP performance hardening.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Cover foreign keys reported by the Supabase database advisor.

create index if not exists waybill_quality_resolutions_created_by_idx
  on public.waybill_quality_resolutions(created_by);

create index if not exists waybill_quality_resolutions_revoked_by_idx
  on public.waybill_quality_resolutions(revoked_by);
