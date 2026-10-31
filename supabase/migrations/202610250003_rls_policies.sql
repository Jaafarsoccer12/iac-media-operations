-- RLS is the final access boundary for connected deployments.
alter table public.profiles enable row level security;
alter table public.role_definitions enable row level security;
alter table public.events enable row level security;
alter table public.event_private_notes enable row level security;
alter table public.event_templates enable row level security;
alter table public.event_template_roles enable row level security;
alter table public.equipment_categories enable row level security;
alter table public.equipment_assets enable row level security;
alter table public.role_assignments enable row level security;
alter table public.operator_qualifications enable row level security;
alter table public.training_resources enable row level security;
alter table public.training_records enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.checklist_template_versions enable row level security;
alter table public.checklist_template_items enable row level security;
alter table public.role_checklist_templates enable row level security;
alter table public.checklist_instances enable row level security;
alter table public.checklist_items enable row level security;
alter table public.equipment_reservations enable row level security;
alter table public.equipment_checkouts enable row level security;
alter table public.equipment_returns enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.sops enable row level security;
alter table public.sop_versions enable row level security;
alter table public.sop_steps enable row level security;
alter table public.notifications enable row level security;
alter table public.announcements enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_history enable row level security;
alter table public.content_projects enable row level security;
alter table public.content_workflow_history enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select_scoped on public.profiles for select to authenticated using (
 id=auth.uid() or public.current_role() in ('Administrator','Media Director') or
 exists(select 1 from public.role_assignments own where own.user_id=auth.uid() and exists(select 1 from public.role_assignments other where other.event_id=own.event_id and other.user_id=profiles.id)) or
 (public.current_role()='Team Lead' and exists(select 1 from public.events e where e.event_lead_id=auth.uid() and exists(select 1 from public.role_assignments a where a.event_id=e.id and a.user_id=profiles.id)))
);
create policy profiles_update_admin on public.profiles for update to authenticated using(public.current_role()='Administrator') with check(public.current_role()='Administrator');
create policy role_definitions_select on public.role_definitions for select to authenticated using(true);
create policy events_select_scoped on public.events for select to authenticated using(
 public.is_manager() or public.can_access_event(id) or (public.current_role()='Event Organizer' and status='Published')
);
create policy events_insert_manager on public.events for insert to authenticated with check(public.is_manager() and created_by=auth.uid());
create policy events_update_manager on public.events for update to authenticated using(public.is_manager()) with check(public.is_manager());
create policy events_delete_admin on public.events for delete to authenticated using(public.current_role()='Administrator');
create policy private_notes_select_staff_scope on public.event_private_notes for select to authenticated using(
 public.is_manager() or (public.current_role()='Team Lead' and (public.leads_event(event_id) or public.assigned_to_event(event_id)))
);
create policy private_notes_write_manager on public.event_private_notes for all to authenticated using(public.is_manager()) with check(public.is_manager() and updated_by=auth.uid());
create policy event_templates_select on public.event_templates for select to authenticated using(active and public.is_staff());
create policy event_templates_write on public.event_templates for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy event_template_roles_select on public.event_template_roles for select to authenticated using(public.is_staff());
create policy event_template_roles_write on public.event_template_roles for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy equipment_categories_select on public.equipment_categories for select to authenticated using(true);
create policy equipment_categories_write on public.equipment_categories for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy equipment_assets_select on public.equipment_assets for select to authenticated using(
 public.is_staff() or exists(select 1 from public.equipment_reservations r where r.asset_id=id and public.assigned_to_event(r.event_id))
);
create policy equipment_assets_insert on public.equipment_assets for insert to authenticated with check(
 public.is_staff() and created_by=auth.uid() and
 status=case when condition in ('Needs service','Damaged','Unknown') then 'Under maintenance' else 'Available' end
);
create policy assignments_select_scoped on public.role_assignments for select to authenticated using(
 public.is_manager() or user_id=auth.uid() or (public.current_role()='Team Lead' and (public.leads_event(event_id) or public.assigned_to_event(event_id)))
);
create policy qualifications_select_scoped on public.operator_qualifications for select to authenticated using(user_id=auth.uid() or public.is_staff());
create policy qualifications_insert_admin on public.operator_qualifications for insert to authenticated with check(public.current_role()='Administrator');
create policy qualifications_update_admin on public.operator_qualifications for update to authenticated using(public.current_role()='Administrator') with check(public.current_role()='Administrator');
create policy training_resources_select on public.training_resources for select to authenticated using((published and public.current_role()<>'Event Organizer') or public.is_manager());
create policy training_resources_write on public.training_resources for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy training_records_select on public.training_records for select to authenticated using(user_id=auth.uid() or public.is_staff());
create policy training_records_write on public.training_records for all to authenticated using(public.is_staff()) with check(public.is_staff());
create policy checklist_templates_select on public.checklist_templates for select to authenticated using(published or public.is_manager());
create policy checklist_templates_write on public.checklist_templates for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy checklist_versions_select on public.checklist_template_versions for select to authenticated using(
 exists(select 1 from public.checklist_templates t where t.id=template_id and (t.published or public.is_manager()))
);
create policy checklist_versions_write on public.checklist_template_versions for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy checklist_template_items_select on public.checklist_template_items for select to authenticated using(
 exists(select 1 from public.checklist_template_versions v join public.checklist_templates t on t.id=v.template_id where v.id=version_id and (t.published or public.is_manager()))
);
create policy checklist_template_items_write on public.checklist_template_items for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy role_checklists_select on public.role_checklist_templates for select to authenticated using(active or public.is_manager());
create policy role_checklists_write on public.role_checklist_templates for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy checklist_instances_select on public.checklist_instances for select to authenticated using(
 public.is_manager() or (public.current_role()='Team Lead' and (public.leads_event(event_id) or public.assigned_to_event(event_id))) or
 exists(select 1 from public.role_assignments a where a.id=assignment_id and a.user_id=auth.uid())
);
create policy checklist_items_select on public.checklist_items for select to authenticated using(
 assigned_user_id=auth.uid() or public.is_manager() or (public.current_role()='Team Lead' and exists(select 1 from public.checklist_instances ci where ci.id=instance_id and (public.leads_event(ci.event_id) or public.assigned_to_event(ci.event_id))))
);
create policy reservations_select on public.equipment_reservations for select to authenticated using(public.is_staff() or public.assigned_to_event(event_id));
create policy checkouts_select on public.equipment_checkouts for select to authenticated using(public.is_staff() or public.assigned_to_event(event_id));
create policy returns_select on public.equipment_returns for select to authenticated using(
 public.is_staff() or exists(select 1 from public.equipment_checkouts c where c.id=checkout_id and public.assigned_to_event(c.event_id))
);
create policy maintenance_select on public.maintenance_records for select to authenticated using(
 public.is_staff() or exists(select 1 from public.incidents i where i.asset_id=maintenance_records.asset_id and i.reported_by=auth.uid())
);
create policy sops_select on public.sops for select to authenticated using((status='Published' and public.current_role()<>'Event Organizer') or public.is_staff());
create policy sops_write on public.sops for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy sop_versions_select on public.sop_versions for select to authenticated using(
 exists(select 1 from public.sops s where s.id=sop_id and ((s.status='Published' and public.current_role()<>'Event Organizer') or public.is_staff()))
);
create policy sop_versions_write on public.sop_versions for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy sop_steps_select on public.sop_steps for select to authenticated using(
 exists(select 1 from public.sop_versions v join public.sops s on s.id=v.sop_id where v.id=sop_version_id and ((s.status='Published' and public.current_role()<>'Event Organizer') or public.is_staff()))
);
create policy sop_steps_write on public.sop_steps for all to authenticated using(public.is_manager()) with check(public.is_manager());
create policy notifications_select_own on public.notifications for select to authenticated using(user_id=auth.uid());
create policy notifications_update_own on public.notifications for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy announcements_select on public.announcements for select to authenticated using(
 (published and (event_id is null or public.can_access_event(event_id))) or public.is_manager()
);
create policy announcements_write on public.announcements for all to authenticated using(public.is_manager()) with check(public.is_manager() and created_by=auth.uid());
create policy incidents_select_scoped on public.incidents for select to authenticated using(
 public.is_manager() or reported_by=auth.uid() or (event_id is not null and public.can_access_event(event_id))
);
create policy incidents_insert_assigned on public.incidents for insert to authenticated with check(
 reported_by=auth.uid() and status='Open' and resolved_by is null and resolved_at is null and resolution_notes is null and assigned_to is null
 and (
  public.is_staff() or (event_id is null and asset_id is null) or
  (event_id is not null and public.assigned_to_event(event_id) and (
   asset_id is null or exists(select 1 from public.equipment_reservations r where r.event_id=incidents.event_id and r.asset_id=incidents.asset_id)
  ))
 )
);
create policy incidents_update_staff on public.incidents for update to authenticated using(
 public.is_manager() or (public.current_role()='Team Lead' and event_id is not null and (public.leads_event(event_id) or public.assigned_to_event(event_id)))
) with check((public.is_manager() or public.current_role()='Team Lead') and status='Resolved' and resolved_by=auth.uid() and resolved_at is not null and length(trim(coalesce(resolution_notes,'')))>=5);
create policy incident_history_select on public.incident_history for select to authenticated using(
 public.is_manager() or exists(select 1 from public.incidents i where i.id=incident_id and (i.reported_by=auth.uid() or (i.event_id is not null and public.can_access_event(i.event_id))))
);
create policy content_select_scoped on public.content_projects for select to authenticated using(
 public.is_manager() or assigned_editor_id=auth.uid() or assigned_reviewer_id=auth.uid()
);
create policy content_history_select on public.content_workflow_history for select to authenticated using(
 public.is_manager() or exists(select 1 from public.content_projects c where c.id=content_project_id and (c.assigned_editor_id=auth.uid() or c.assigned_reviewer_id=auth.uid()))
);
create policy audit_admin_select on public.audit_logs for select to authenticated using(public.current_role()='Administrator');

-- Explicit grants keep RPC-backed tables read-only to clients.
revoke all on all tables in schema public from anon,authenticated;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert on public.equipment_assets to authenticated;
grant insert(event_id,asset_id,reported_by,category,severity,description,immediate_action) on public.incidents to authenticated;
grant update(status,resolution_notes,resolved_by,resolved_at) on public.incidents to authenticated;
grant update(read_at) on public.notifications to authenticated;
grant update(full_name) on public.profiles to authenticated;
revoke execute on function public.current_role(),public.is_manager(),public.is_staff(),public.leads_event(uuid),public.assigned_to_event(uuid),public.can_access_event(uuid) from public,anon;
revoke execute on function public.create_event_with_notes(text,text,date,time,time,time,text,text,uuid,text,boolean,boolean,boolean,text,text) from public,anon;
revoke execute on function public.update_event_with_notes(uuid,text,text,date,time,time,time,text,text,uuid,text,boolean,boolean,boolean,text,text) from public,anon;
revoke execute on function public.publish_event_schedule(uuid) from public,anon;
revoke execute on function public.create_event_assignment_with_checklist(uuid,uuid,text,time,text,uuid) from public,anon;
revoke execute on function public.acknowledge_assignment(uuid,text) from public,anon;
revoke execute on function public.complete_checklist_item(uuid,text,text) from public,anon;
revoke execute on function public.reserve_equipment_asset(uuid,uuid,uuid) from public,anon;
revoke execute on function public.checkout_equipment(uuid,uuid,text) from public,anon;
revoke execute on function public.return_equipment(uuid,text,text) from public,anon;
revoke execute on function public.create_sop_draft(text,text,text,text[]) from public,anon;
revoke execute on function public.publish_sop_version(uuid) from public,anon;
revoke execute on function public.transition_content_stage(uuid,text,text,text,text) from public,anon;
grant execute on function public.current_role(),public.is_manager(),public.is_staff(),public.leads_event(uuid),public.assigned_to_event(uuid),public.can_access_event(uuid) to authenticated;
grant execute on function public.create_event_with_notes(text,text,date,time,time,time,text,text,uuid,text,boolean,boolean,boolean,text,text) to authenticated;
grant execute on function public.update_event_with_notes(uuid,text,text,date,time,time,time,text,text,uuid,text,boolean,boolean,boolean,text,text) to authenticated;
grant execute on function public.publish_event_schedule(uuid) to authenticated;
grant execute on function public.create_event_assignment_with_checklist(uuid,uuid,text,time,text,uuid) to authenticated;
grant execute on function public.acknowledge_assignment(uuid,text) to authenticated;
grant execute on function public.complete_checklist_item(uuid,text,text) to authenticated;
grant execute on function public.reserve_equipment_asset(uuid,uuid,uuid) to authenticated;
grant execute on function public.checkout_equipment(uuid,uuid,text) to authenticated;
grant execute on function public.return_equipment(uuid,text,text) to authenticated;
grant execute on function public.create_sop_draft(text,text,text,text[]) to authenticated;
grant execute on function public.publish_sop_version(uuid) to authenticated;
grant execute on function public.transition_content_stage(uuid,text,text,text,text) to authenticated;
revoke execute on function public.handle_new_auth_user() from public,anon,authenticated;
revoke execute on function public.write_audit_log() from public,anon,authenticated;
revoke execute on function public.record_incident_history() from public,anon,authenticated;
revoke execute on function public.notify_incident_leads() from public,anon,authenticated;
revoke execute on function public.flag_incident_asset() from public,anon,authenticated;

