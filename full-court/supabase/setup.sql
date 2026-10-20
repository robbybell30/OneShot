-- Full Court private league schema. Run once in Supabase SQL Editor.
-- game_date is the NBA slate date in America/New_York.

create table public.seasons (
  id uuid primary key default gen_random_uuid(), name text not null,
  start_date date not null, end_date date not null, check (end_date >= start_date)
);
create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id),
  name text not null, invite_code text not null unique,
  created_at timestamptz not null default now()
);
create table public.league_members (
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null, role text not null default 'member'
    check (role in ('admin','member')),
  joined_at timestamptz not null default now(), primary key (league_id,user_id)
);
create table public.players (
  id text primary key, full_name text not null, team_code text,
  active boolean not null default true
);
create table public.games (
  id text primary key, season_id uuid not null references public.seasons(id),
  game_date date not null, tipoff_at timestamptz not null,
  home_team text not null, away_team text not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','live','final','postponed','canceled'))
);
create table public.player_games (
  game_id text not null references public.games(id) on delete cascade,
  player_id text not null references public.players(id), primary key (game_id,player_id)
);
create table public.daily_projections (
  season_id uuid not null references public.seasons(id), game_date date not null,
  player_id text not null references public.players(id),
  points numeric(5,1) not null default 0 check(points >= 0),
  rebounds numeric(5,1) not null default 0 check(rebounds >= 0),
  assists numeric(5,1) not null default 0 check(assists >= 0),
  steals numeric(5,1) not null default 0 check(steals >= 0),
  blocks numeric(5,1) not null default 0 check(blocks >= 0),
  updated_at timestamptz not null default now(),
  primary key (season_id,game_date,player_id)
);
create table public.box_scores (
  game_id text not null references public.games(id) on delete cascade,
  player_id text not null references public.players(id),
  points integer not null default 0 check(points >= 0),
  rebounds integer not null default 0 check(rebounds >= 0),
  assists integer not null default 0 check(assists >= 0),
  steals integer not null default 0 check(steals >= 0),
  blocks integer not null default 0 check(blocks >= 0),
  primary key (game_id,player_id)
);
create table public.picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  season_id uuid not null references public.seasons(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  game_date date not null, player_id text not null references public.players(id),
  display_name text not null, picked_at timestamptz not null default now(),
  unique (league_id,user_id,game_date),
  unique (league_id,season_id,user_id,player_id)
);
create index games_date_idx on public.games(season_id,game_date,tipoff_at);
create index picks_board_idx on public.picks(league_id,user_id);

create or replace function public.is_league_member(p_league_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.league_members m
    where m.league_id=p_league_id and m.user_id=auth.uid());
$$;
create or replace function public.is_season_member(p_season_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leagues l
    join public.league_members m on m.league_id=l.id
    where l.season_id=p_season_id and m.user_id=auth.uid());
$$;

create or replace function public.join_league(p_invite_code text,p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user_id uuid:=auth.uid(); v_league_id uuid; v_role text;
begin
  if v_user_id is null then raise exception 'Sign in first'; end if;
  if length(trim(coalesce(p_display_name,'')))<2 then
    raise exception 'Display name must be at least two characters';
  end if;
  select id into v_league_id from public.leagues
    where upper(invite_code)=upper(trim(p_invite_code));
  if v_league_id is null then raise exception 'Invite code not found'; end if;
  if exists(select 1 from public.league_members
      where league_id=v_league_id and user_id=v_user_id) then return v_league_id; end if;
  if not exists(select 1 from public.league_members where league_id=v_league_id)
    then v_role:='admin'; else v_role:='member'; end if;
  insert into public.league_members(league_id,user_id,display_name,role)
    values(v_league_id,v_user_id,trim(p_display_name),v_role);
  return v_league_id;
end;
$$;

create or replace function public.make_pick(p_league_id uuid,p_game_date date,p_player_id text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid:=auth.uid(); v_season_id uuid; v_first_tipoff timestamptz;
  v_name text; v_pick_id uuid;
begin
  if v_user_id is null then raise exception 'Sign in to make a pick'; end if;
  if p_game_date <> (now() at time zone 'America/New_York')::date then
    raise exception 'Picks can only be submitted for today’s slate';
  end if;
  select l.season_id into v_season_id from public.leagues l where l.id=p_league_id;
  if v_season_id is null or not public.is_league_member(p_league_id) then
    raise exception 'You are not a member of this league'; end if;
  select min(g.tipoff_at) into v_first_tipoff from public.games g
    where g.season_id=v_season_id and g.game_date=p_game_date and g.status<>'canceled';
  if v_first_tipoff is null then raise exception 'No games are loaded for this date'; end if;
  if now()>=v_first_tipoff then raise exception 'Picks are locked at first tip-off'; end if;
  if not exists(select 1 from public.player_games pg join public.games g on g.id=pg.game_id
    where pg.player_id=p_player_id and g.season_id=v_season_id and g.game_date=p_game_date
      and g.status not in ('canceled','postponed')) then
    raise exception 'That player is not playing on this date'; end if;
  select m.display_name into v_name from public.league_members m
    where m.league_id=p_league_id and m.user_id=v_user_id;
  insert into public.picks(league_id,season_id,user_id,game_date,player_id,display_name)
    values(p_league_id,v_season_id,v_user_id,p_game_date,p_player_id,v_name)
    returning id into v_pick_id;
  return v_pick_id;
end;
$$;

create or replace view public.daily_scores with (security_invoker=true) as
select p.id as pick_id,p.league_id,p.season_id,p.user_id,p.display_name,
  p.game_date,p.player_id,pl.full_name as player_name,
  coalesce(sum(bs.points+bs.rebounds+bs.assists+bs.steals+bs.blocks),0)::integer as score,
  coalesce(bool_and(g.status='final') and count(bs.player_id)>0,false) as is_final
from public.picks p join public.players pl on pl.id=p.player_id
left join public.games g on g.season_id=p.season_id and g.game_date=p.game_date
left join public.player_games pg on pg.game_id=g.id and pg.player_id=p.player_id
left join public.box_scores bs on bs.game_id=g.id and bs.player_id=p.player_id
where pg.player_id is not null
group by p.id,p.league_id,p.season_id,p.user_id,p.display_name,p.game_date,p.player_id,pl.full_name;

create or replace view public.league_standings with (security_invoker=true) as
select m.league_id,m.user_id,m.display_name,
  coalesce(sum(case when ds.is_final then ds.score else 0 end),0)::integer as total_points,
  count(ds.pick_id)::integer as pick_count,
  count(distinct ds.player_id)::integer as used_player_count
from public.league_members m left join public.daily_scores ds
  on ds.league_id=m.league_id and ds.user_id=m.user_id
group by m.league_id,m.user_id,m.display_name;

alter table public.seasons enable row level security;
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.player_games enable row level security;
alter table public.daily_projections enable row level security;
alter table public.box_scores enable row level security;
alter table public.picks enable row level security;

create policy "League members read seasons" on public.seasons for select to authenticated
using(public.is_season_member(id));
create policy "Members read their leagues" on public.leagues for select to authenticated
using(public.is_league_member(id));
create policy "Members read league roster" on public.league_members for select to authenticated
using(public.is_league_member(league_id));
create policy "League members read players" on public.players for select to authenticated
using(exists(select 1 from public.player_games pg join public.games g on g.id=pg.game_id
  where pg.player_id=players.id and public.is_season_member(g.season_id)));
create policy "League members read games" on public.games for select to authenticated
using(public.is_season_member(season_id));
create policy "League members read game rosters" on public.player_games for select to authenticated
using(exists(select 1 from public.games g where g.id=player_games.game_id
  and public.is_season_member(g.season_id)));
create policy "League members read projections" on public.daily_projections for select to authenticated
using(public.is_season_member(season_id));
create policy "League members read box scores" on public.box_scores for select to authenticated
using(exists(select 1 from public.games g where g.id=box_scores.game_id
  and public.is_season_member(g.season_id)));
create policy "League members read picks" on public.picks for select to authenticated
using(public.is_league_member(league_id));

revoke all on function public.join_league(text,text) from public;
revoke all on function public.make_pick(uuid,date,text) from public;
revoke all on function public.is_league_member(uuid) from public;
revoke all on function public.is_season_member(uuid) from public;
grant execute on function public.join_league(text,text) to authenticated;
grant execute on function public.make_pick(uuid,date,text) to authenticated;
grant execute on function public.is_league_member(uuid) to authenticated;
grant execute on function public.is_season_member(uuid) to authenticated;
grant select on public.seasons,public.leagues,public.league_members,public.players,
  public.games,public.player_games,public.daily_projections,public.box_scores,public.picks
  to authenticated;
grant select on public.league_standings,public.daily_scores to authenticated;
