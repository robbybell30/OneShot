import { useEffect, useMemo, useState } from 'react';
import { configured, supabase } from './supabase';

function nbaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function dateLabel(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric'
  }).format(new Date(`${date}T12:00:00-04:00`));
}
function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }
function projectionTotal(p) { return ['points','rebounds','assists','steals','blocks'].reduce((n, k) => n + Number(p[k] || 0), 0); }
function actualLabel(row) { return row.is_final ? `${row.score} FPTS` : 'Pending'; }

export default function App() {
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [league, setLeague] = useState(null);
  const [member, setMember] = useState(null);
  const [players, setPlayers] = useState([]);
  const [standings, setStandings] = useState([]);
  const [todayPick, setTodayPick] = useState(null);
  const [firstTipoff, setFirstTipoff] = useState(null);
  const [today, setToday] = useState(nbaDate());
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) { setLeague(null); setMember(null); return; }
    loadMembership();
  }, [session?.user?.id]);

  useEffect(() => {
    if (!league || !member) return;
    loadGameData();
  }, [league?.id, member?.user_id, today]);

  async function run(action) {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); }
    catch (e) { setError(e?.message || 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  async function submitAuth(e) {
    e.preventDefault();
    await run(async () => {
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) setNotice('Check your email to confirm your account, then sign in.');
        else setNotice('Account created. Enter your league invite code to join.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    });
  }

  async function loadMembership() {
    const { data, error } = await supabase
      .from('league_members')
      .select('league_id,user_id,display_name,role,leagues(id,name,season_id,seasons(id,name,start_date,end_date))')
      .eq('user_id', session.user.id)
      .limit(1)
      .maybeSingle();
    if (error) { setError(error.message); return; }
    if (data) { setMember(data); setLeague(data.leagues); }
  }

  async function joinLeague(e) {
    e.preventDefault();
    await run(async () => {
      const { error } = await supabase.rpc('join_league', {
        p_invite_code: inviteCode.trim(), p_display_name: displayName.trim()
      });
      if (error) throw error;
      await loadMembership();
      setNotice('You joined the league.');
    });
  }

  async function loadGameData() {
    setError('');
    const [{ data: proj, error: projError }, { data: picks, error: pickError }, { data: board, error: boardError }, { data: games, error: gameError }] = await Promise.all([
      supabase.from('daily_projections')
        .select('season_id,game_date,player_id,points,rebounds,assists,steals,blocks,players(id,full_name,team_code)')
        .eq('season_id', league.season_id).eq('game_date', today),
      supabase.from('picks').select('id,game_date,player_id,display_name')
        .eq('league_id', league.id).eq('user_id', session.user.id).eq('game_date', today).maybeSingle(),
      supabase.from('league_standings').select('*').eq('league_id', league.id)
        .order('total_points', { ascending: false }),
      supabase.from('games').select('tipoff_at,status')
        .eq('season_id', league.season_id).eq('game_date', today).neq('status', 'canceled')
    ]);
    if (projError || pickError || boardError || gameError) {
      setError((projError || pickError || boardError || gameError).message);
      return;
    }
    const eligible = (proj || []).map(p => ({ ...p, ...p.players, projected: projectionTotal(p) }))
      .sort((a,b) => b.projected - a.projected);
    setPlayers(eligible); setTodayPick(picks || null); setStandings(board || []);
    setFirstTipoff((games || []).map(g=>g.tipoff_at).sort()[0] || null);
  }

  async function makePick(player) {
    await run(async () => {
      const { error } = await supabase.rpc('make_pick', {
        p_league_id: league.id, p_game_date: today, p_player_id: player.id
      });
      if (error) throw error;
      await loadGameData();
      setNotice(`${player.full_name} is your pick for ${dateLabel(today)}.`);
    });
  }

  async function signOut() { await supabase.auth.signOut(); setLeague(null); setMember(null); }

  const teams = useMemo(() => [...new Set(players.map(p => p.team_code).filter(Boolean))].sort(), [players]);
  const visiblePlayers = players.filter(p =>
    (teamFilter === 'all' || p.team_code === teamFilter) &&
    `${p.full_name} ${p.team_code || ''}`.toLowerCase().includes(query.toLowerCase())
  );
  const myStanding = standings.find(x => x.user_id === session?.user?.id);
  const pickLocked = firstTipoff && Date.now() >= new Date(firstTipoff).getTime();

  if (!configured) return <Shell><Notice kind="error">Add your Supabase URL and publishable key to <code>.env.local</code>, then restart the dev server. See README.md.</Notice></Shell>;

  if (!session) return <Shell>
    <header className="top"><Brand/><span className="topnote">Private group league</span></header>
    <section className="auth card">
      <div className="eyebrow">2026–27 · PRIVATE LEAGUE</div>
      <h1>{authMode === 'signin' ? 'Welcome back.' : 'Join the game.'}</h1>
      <p className="muted">One player a day. Every stat counts.</p>
      <form onSubmit={submitAuth} className="form">
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} minLength="8" required value={password} onChange={e=>setPassword(e.target.value)} /></label>
        <button className="primary full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      <p className="switch">{authMode === 'signin' ? 'New to the league?' : 'Already have an account?'} <button onClick={()=>setAuthMode(authMode === 'signin' ? 'signup' : 'signin')}>{authMode === 'signin' ? 'Create account' : 'Sign in'}</button></p>
      <Notice kind="info">This is a private league. You’ll need an invite code after signing in.</Notice>
      <Messages error={error} notice={notice}/>
    </section>
  </Shell>;

  if (!league || !member) return <Shell>
    <header className="top"><Brand/><button className="textButton" onClick={signOut}>Sign out</button></header>
    <section className="auth card">
      <div className="eyebrow">ACCOUNT READY</div><h1>Join your league.</h1>
      <p className="muted">Enter the private invite code from your league admin.</p>
      <form onSubmit={joinLeague} className="form">
        <label>Display name<input required maxLength="28" value={displayName} onChange={e=>setDisplayName(e.target.value)} /></label>
        <label>League invite code<input required autoCapitalize="characters" value={inviteCode} onChange={e=>setInviteCode(e.target.value)} /></label>
        <button className="primary full" disabled={busy}>{busy ? 'Joining…' : 'Join league'}</button>
      </form><Messages error={error} notice={notice}/>
    </section>
  </Shell>;

  return <Shell>
    <header className="top"><Brand/><nav><a className="active" href="#pick">Today’s pick</a><a href="#standings">Standings</a><a href="#rules">Rules</a></nav><div className="account"><span>{member.display_name}</span><button className="textButton" onClick={signOut}>Sign out</button></div></header>
    <section className="hero"><div><div className="eyebrow">{league.seasons?.name || league.name}</div><h1>Make your pick.<br/>Make it count.</h1><p className="muted">One player playing today. Their box score becomes your season score.</p></div><div className="leagueTag">🏀 &nbsp;{league.name}</div></section>
    <Messages error={error} notice={notice}/>
    <main className="grid">
      <section className="card" id="pick">
        <div className="cardHead"><div><h2>Today’s player rankings</h2><p className="muted">Sorted by projected points + rebounds + assists + steals + blocks</p></div><span className="status">{!firstTipoff?'SLATE NOT LOADED':pickLocked?'PICKS LOCKED':'PICK OPEN'}</span></div>
        <div className="dateBar"><div><small>NBA GAME DAY · EASTERN TIME</small><strong>{dateLabel(today)}</strong></div><span>Locks at first tip-off</span></div>
        <div className="filters"><input placeholder="Search players…" value={query} onChange={e=>setQuery(e.target.value)} /><select value={teamFilter} onChange={e=>setTeamFilter(e.target.value)}><option value="all">All teams</option>{teams.map(t=><option key={t}>{t}</option>)}</select></div>
        <div className="tableWrap"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th className="right">Proj.</th><th className="right">P · R · A · S · B</th><th></th></tr></thead><tbody>
          {visiblePlayers.map((p,i)=><tr key={p.id}><td className="rank">{players.indexOf(p)+1}</td><td><div className="player"><span className="face">{initials(p.full_name)}</span><b>{p.full_name}</b></div></td><td className="muted">{p.team_code || '—'}</td><td className="right projection">{p.projected.toFixed(1)}</td><td className="right muted stats">{p.points} · {p.rebounds} · {p.assists} · {p.steals} · {p.blocks}</td><td><button className="pickButton" disabled={!!todayPick || pickLocked || busy} onClick={()=>makePick(p)}>{todayPick?.player_id === p.id ? 'Your pick' : todayPick || pickLocked ? 'Locked' : 'Pick'}</button></td></tr>)}
          {!visiblePlayers.length && <tr><td colSpan="6" className="empty">{players.length ? 'No players match your search.' : 'No projections loaded for today yet. Your league admin needs to add today’s games and projections.'}</td></tr>}
        </tbody></table></div>
        <p className="footnote">Projections are estimates for ranking only. Final points use the player’s actual box score.</p>
      </section>
      <aside className="side">
        <section className="card myCard"><div className="rowBetween"><div><h2>Your season</h2><p className="muted">{league.name}</p></div><span className="rankBadge">#{Math.max(1, standings.findIndex(x=>x.user_id===session.user.id)+1)}</span></div><div className="bigTotal">{Number(myStanding?.total_points || 0)} <small>FPTS</small></div><div className="metrics"><div><b>{myStanding?.pick_count || 0}</b><span>Picks</span></div><div><b>{myStanding?.used_player_count || 0}</b><span>Players used</span></div><div><b>{todayPick ? '1/1' : '0/1'}</b><span>Today</span></div></div><div className="todayLine"><span>Today’s pick</span><b>{todayPick ? players.find(p=>p.id===todayPick.player_id)?.full_name || todayPick.display_name : 'Not made yet'}</b></div></section>
        <section className="card" id="standings"><div className="cardHead"><div><h2>Season leaderboard</h2><p className="muted">Most total fantasy points wins</p></div><span>🏆</span></div><div className="leaders">{standings.map((s,i)=><div className="leader" key={s.user_id}><span className="rank">{String(i+1).padStart(2,'0')}</span><span className="face smallFace">{initials(s.display_name)}</span><b>{s.display_name}{s.user_id===session.user.id?' (you)':''}</b><strong>{Number(s.total_points||0)}</strong></div>)}{!standings.length&&<p className="empty">Standings appear after league members join.</p>}</div></section>
        <section className="card rules" id="rules"><h2>Scoring</h2><div className="chips">{['PTS','REB','AST','STL','BLK'].map(x=><span key={x}>{x} <b>+1</b></span>)}</div><p className="muted">Use each player once this season. Picks lock at the first game’s tip-off.</p></section>
      </aside>
    </main>
  </Shell>;
}

function Shell({children}) { return <div className="app">{children}<footer>FULL COURT · PRIVATE GROUP GAME</footer></div>; }
function Brand() { return <div className="brand"><span className="ball">↗</span><span>FULL COURT<small>one pick. all season.</small></span></div>; }
function Notice({kind='info',children}) { return <div className={`notice ${kind}`}>{children}</div>; }
function Messages({error,notice}) { return <>{error&&<Notice kind="error">{error}</Notice>}{notice&&<Notice>{notice}</Notice>}</>; }
