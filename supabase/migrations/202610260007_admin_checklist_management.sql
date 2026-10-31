create or replace function public.sync_checklist_instance_status(p_instance_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.checklist_instances ci set status=case
    when exists(select 1 from public.checklist_items i where i.instance_id=p_instance_id and i.is_required and i.status='Needs attention') then 'Needs attention'
    when not exists(select 1 from public.checklist_items i where i.instance_id=p_instance_id and i.is_required and i.status<>'Complete') then 'Ready'
    else 'In progress' end
  where ci.id=p_instance_id;
end; $$;
revoke execute on function public.sync_checklist_instance_status(uuid) from public,anon,authenticated;

create or replace function public.admin_create_checklist_item(p_assignment_id uuid,p_label text,p_is_required boolean default true) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_assignment public.role_assignments%rowtype;
  v_instance uuid;
  v_step integer;
  v_item uuid;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.role='Administrator' or 'Administrator'=any(p.access_roles))) then
    raise exception 'Only the administrator can manage checklist items' using errcode='42501';
  end if;
  if length(trim(coalesce(p_label,''))) not between 2 and 240 then raise exception 'Checklist item must be 2 to 240 characters'; end if;
  select * into v_assignment from public.role_assignments where id=p_assignment_id;
  if not found then raise exception 'Member assignment not found'; end if;

  select id into v_instance from public.checklist_instances where assignment_id=p_assignment_id for update;
  if v_instance is null then
    insert into public.checklist_instances(event_id,assignment_id,title,role_name,created_by)
      values(v_assignment.event_id,p_assignment_id,v_assignment.role_name||' checklist',v_assignment.role_name,auth.uid())
      returning id into v_instance;
  end if;
  select coalesce(max(step_order),0)+1 into v_step from public.checklist_items where instance_id=v_instance;
  insert into public.checklist_items(instance_id,step_order,label,is_required,assigned_user_id,assigned_role)
    values(v_instance,v_step,trim(p_label),coalesce(p_is_required,true),v_assignment.user_id,v_assignment.role_name)
    returning id into v_item;
  perform public.sync_checklist_instance_status(v_instance);
  insert into public.notifications(user_id,title,body,href)
    values(v_assignment.user_id,'New checklist item',trim(p_label),'checklists');
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Added checklist item','checklist_item',v_item,jsonb_build_object('assignment_id',p_assignment_id));
  return v_item;
end; $$;

create or replace function public.admin_update_checklist_item(p_item_id uuid,p_label text,p_is_required boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_instance uuid;
  v_user uuid;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.role='Administrator' or 'Administrator'=any(p.access_roles))) then
    raise exception 'Only the administrator can manage checklist items' using errcode='42501';
  end if;
  if length(trim(coalesce(p_label,''))) not between 2 and 240 then raise exception 'Checklist item must be 2 to 240 characters'; end if;
  select instance_id,assigned_user_id into v_instance,v_user from public.checklist_items where id=p_item_id for update;
  if not found then raise exception 'Checklist item not found'; end if;
  update public.checklist_items set label=trim(p_label),is_required=coalesce(p_is_required,true) where id=p_item_id;
  perform public.sync_checklist_instance_status(v_instance);
  if v_user is not null then
    insert into public.notifications(user_id,title,body,href) values(v_user,'Checklist item updated',trim(p_label),'checklists');
  end if;
  insert into public.audit_logs(actor_id,action,target_type,target_id)
    values(auth.uid(),'Edited checklist item','checklist_item',p_item_id);
end; $$;

create or replace function public.admin_delete_checklist_item(p_item_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_instance uuid;
  v_user uuid;
  v_label text;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and (p.role='Administrator' or 'Administrator'=any(p.access_roles))) then
    raise exception 'Only the administrator can manage checklist items' using errcode='42501';
  end if;
  select instance_id,assigned_user_id,label into v_instance,v_user,v_label from public.checklist_items where id=p_item_id for update;
  if not found then raise exception 'Checklist item not found'; end if;
  delete from public.checklist_items where id=p_item_id;
  perform public.sync_checklist_instance_status(v_instance);
  insert into public.audit_logs(actor_id,action,target_type,target_id,metadata)
    values(auth.uid(),'Removed checklist item','checklist_item',p_item_id,jsonb_build_object('label',v_label,'assignment_id',(select assignment_id from public.checklist_instances where id=v_instance)));
end; $$;

revoke execute on function public.admin_create_checklist_item(uuid,text,boolean) from public,anon;
revoke execute on function public.admin_update_checklist_item(uuid,text,boolean) from public,anon;
revoke execute on function public.admin_delete_checklist_item(uuid) from public,anon;
grant execute on function public.admin_create_checklist_item(uuid,text,boolean) to authenticated;
grant execute on function public.admin_update_checklist_item(uuid,text,boolean) to authenticated;
grant execute on function public.admin_delete_checklist_item(uuid) to authenticated;
