# Full Court — private fantasy basketball game

This is the first connected app scaffold. Accounts, league membership, daily picks, projections, and standings use Supabase. The data itself is entered by a league admin; there is no paid sports feed or automated import in this version.

## 1. Create the database

In your Supabase project, open **SQL Editor → New query**, paste `supabase/setup.sql`, and run it once. It creates the tables, private-group read policies, the invite-code join function, the server-checked pick function, and scoring/standings views.

## 2. Create a season and league

Run this in SQL Editor. Replace the invite code with a long, random code and keep it private. Save the code to share with your group.

```sql
with new_season as (
  insert into public.seasons(name, start_date, end_date)
  values ('NBA 2026–27', '2026-10-20', '2027-06-30')
  returning id
)
insert into public.leagues(season_id, name, invite_code)
select id, 'Full Court', 'REPLACE-WITH-A-LONG-RANDOM-CODE'
from new_season
returning id, name, invite_code;
```

Join the league yourself first, before sharing the code. The first account to join becomes its admin; later members need the invite code to join.

## 3. Configure and run the app

1. Install Node.js (current LTS) if it is not already installed.
2. Copy `.env.example` to `.env.local` in this folder.
3. In `.env.local`, set `VITE_SUPABASE_URL` to your project URL and `VITE_SUPABASE_PUBLISHABLE_KEY` to the publishable key from the Supabase project settings.
4. In Supabase **Authentication → URL Configuration**, allow `http://localhost:5173` as a redirect URL.
5. From this folder, run `npm install`, then `npm run dev`.
6. Open the local URL printed by Vite. Create your account, confirm the email if requested, sign in, then join with the invite code. The first league member is the admin.

For local testing, make sure Supabase **Authentication → URL Configuration** also includes `http://localhost:5173` as the site URL/redirect URL. If email confirmation is enabled, follow the confirmation link before signing in.

The publishable key is meant for the client. Never put a `service_role` or secret key in `.env.local`, the browser, or shared source code. Row Level Security is what protects the tables.

## 4. Load the daily slate and projections

Use Supabase **Table Editor** while signed into the project owner account. Add data in this order:

1. `players`: stable player ID, full name, current team code.
2. `games`: game ID, season ID, NBA game date in Eastern time, exact tip-off timestamp with timezone, home team, away team, and `scheduled` status.
3. `player_games`: one row for each player eligible for each game.
4. `daily_projections`: one row per eligible player with projected points, rebounds, assists, steals, and blocks.

The first data entry pass is simplest as CSV imports in Table Editor. Use NBA.com’s per-game stats as the prior-season basis for the opening slate. The schedule and current roster still need to be entered for each slate; the app does not fetch those automatically.

The rankings sort by the sum of those five projection columns. For the first slate, use previous-season per-game averages as projections. The app only displays players that have a projection and a matching `player_games` row.

## 5. Enter final stats

After a player’s game is final, add a `box_scores` row with their actual five stats and change that game’s status to `final`. The app’s views calculate pick scores and standings from those rows. A pick’s score is counted in the standings only when the player’s game is marked final.

## Rules enforced by the database

- One pick per league member per NBA game date.
- A player can only be used once by a member per season.
- Picks must be for a player listed in that date’s slate.
- Picks can only be submitted for the current NBA game date.
- Picks lock at the earliest non-canceled game tip-off for that date.
- A pick must be submitted through `make_pick`; direct client inserts are not allowed.

## Current limits

This is a starter app, not yet an always-on deployed site. Daily schedule, roster, projections, and final stats require admin entry. Authentication currently uses email/password. The Supabase free tier may pause an inactive project; see Supabase’s current plan limits before relying on it for a full season.
