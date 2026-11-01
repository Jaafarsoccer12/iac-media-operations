-- Add the local demo calendar and equipment rows that are missing from the
-- connected IAC project. This import is additive and can be safely rerun.
-- Demo crew accounts, assignments, loans, notifications, and audit records are
-- intentionally not copied because their IDs do not exist in the connected team.

begin;

select set_config('request.jwt.claim.sub', (
  select id::text from public.profiles
  where active and 'Administrator'=any(access_roles)
  order by created_at
  limit 1
), true);

-- Fill in the schedule for matching published demo events only when the
-- connected record still has no schedule. Preserve any later edits.
update public.events as existing
set start_time=source.start_time,end_time=source.end_time,setup_time=source.setup_time,
  time_zone=source.time_zone,venue=source.venue
from (values
  ('Martyrdom of Lady Fatima - Special Event','2026-11-07'::date,'20:00'::time,'22:00'::time,'19:00'::time,'America/New_York','Main Hall'),
  ('Martydom Of Lady Fatima - Special Event','2026-11-08'::date,'20:00'::time,'22:00'::time,'19:00'::time,'America/New_York','Main Hall')
) as source(title,event_date,start_time,end_time,setup_time,time_zone,venue)
where existing.event_date=source.event_date
  and lower(trim(existing.title))=lower(trim(source.title))
  and existing.status='Published'
  and existing.start_time is null and existing.end_time is null and existing.setup_time is null;

insert into public.events(
  title,category,event_date,start_time,end_time,setup_time,time_zone,venue,event_lead_id,description,
  livestream_required,recording_required,photography_required,public_information,status,created_by
)
select source.title,source.category,source.event_date,null,null,null,'America/New_York','To be confirmed',null,source.description,
  false,false,false,'','Planning',admin.id
from (values
  ('Birth day of Lady Fatima','Happy','2026-12-05'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Imam Al Bagher','Happy','2026-12-11'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Martyrdom of Imam Al Hadi','Sad','2026-12-12'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Imam Al Jawad & Imam Ali','Happy','2026-12-19'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Martyrdom of Lady Zaynab','Sad','2026-12-26'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Martyrdom of Imam Al Kadhum','Sad','2027-01-02'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Mabath','Happy','2027-01-09'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Imam Al Hussain','Happy','2027-01-16'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Abal Fadhl Al Abbas','Happy','2027-01-16'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Imam Al Sajjad','Happy','2027-01-16'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('Birth day of Imam Al Mahdi','Happy','2027-01-23'::date,'Speaker: Sheikh Mustafa Akhound'),
  ('1st of Ramadan','General','2027-02-08'::date,'Quran Recitation+ lecture+ Doa + Iftar · Speaker: Sheikh Mustafa Akhound')
) as source(title,category,event_date,description)
cross join lateral (
  select id from public.profiles
  where active and 'Administrator'=any(access_roles)
  order by created_at
  limit 1
) as admin
where not exists (
  select 1 from public.events existing
  where existing.event_date=source.event_date and lower(trim(existing.title))=lower(trim(source.title))
);

insert into public.equipment_assets(
  asset_code,name,category,storage_location,model,serial_number,quantity,condition,status,current_custodian_id,notes,created_by
)
select source.asset_code,source.name,'Camera',source.storage_location,source.model,nullif(source.serial_number,''),source.quantity,
  'Good',source.status,null,source.notes,admin.id
from (values
  ('IAC-CAM-001','Canon Camera A','Media Room - Locker - 1','Canon RP','442029001927',1,'Checked out','Has The Sennheiser Receiver On Top'),
  ('IAC-CAM-002','Canon Camera B','Media Room - Locker - 1','Canon RP','442029001925',1,'Checked out',''),
  ('IAC-CAM-003','Canon Camera C','Media Room - Locker - 1','Canon RP','442029001929',1,'Checked out',''),
  ('IAC-CAM-004','Canon Lens A','Media Room - Locker - 1','Canon RF 100-400mm F5.6-8 IS USM','1622001454',1,'Checked out','Attached To Camera A'),
  ('IAC-CAM-005','Canon Lens B','Media Room - Locker - 1','Canon RF 100-400mm F5.6-8 IS USM','1622001450',1,'Checked out','Attached To Camera B'),
  ('IAC-CAM-006','Canon Lens C','Media Room - Locker - 1','Canon RF 100-400mm F5.6-8 IS USM','2962001815',1,'Checked out','Attached To Camera C'),
  ('IAC-CAM-010','Tripod B','','Small Rig','',1,'Checked out','Without Handle'),
  ('IAC-CAM-011','512GB SD Card','','SanDisk','',1,'Checked out',''),
  ('IAC-CAM-013','128GB SD Card','','SanDisk','',1,'Checked out','')
) as source(asset_code,name,storage_location,model,serial_number,quantity,status,notes)
cross join lateral (
  select id from public.profiles
  where active and 'Administrator'=any(access_roles)
  order by created_at
  limit 1
) as admin
where not exists (
  select 1 from public.equipment_assets existing where existing.asset_code=source.asset_code
);

commit;
