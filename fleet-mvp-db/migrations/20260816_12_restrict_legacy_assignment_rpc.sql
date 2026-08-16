-- Current UI uses assign_driver_vehicle(p_vehicle_id uuid, p_driver_id uuid).
-- Keep the legacy three-argument overload available to authenticated clients only;
-- remove anonymous/PUBLIC execution inherited from the old default grant.

revoke execute on function public.assign_driver_vehicle(uuid,uuid,boolean) from public;
revoke execute on function public.assign_driver_vehicle(uuid,uuid,boolean) from anon;
grant execute on function public.assign_driver_vehicle(uuid,uuid,boolean) to authenticated;
