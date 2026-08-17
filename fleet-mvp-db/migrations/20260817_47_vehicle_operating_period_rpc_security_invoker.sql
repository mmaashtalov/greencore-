alter function public.get_vehicle_operating_period_summary(uuid,timestamptz,timestamptz) security invoker;
alter function public.get_vehicle_operating_summary(uuid) security invoker;

revoke all on function public.get_vehicle_operating_period_summary(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.get_vehicle_operating_period_summary(uuid,timestamptz,timestamptz) to authenticated;
revoke all on function public.get_vehicle_operating_summary(uuid) from public,anon;
grant execute on function public.get_vehicle_operating_summary(uuid) to authenticated;
