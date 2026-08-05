'use client';

import { ChangeEvent, DragEvent, useEffect, useMemo, useState } from 'react';

type Tab = 'planner' | 'calendar' | 'risk';
type RolePool = 'dps' | 'healer' | 'fixed';
type RosterPlayer = {
  name:string;
  class:string;
  spec:string;
  role:string;
  benchEligible?:boolean;
  eligibleSpecs?:string[];
  curse?:'CoE' | 'CoR' | string;
};
type Raid = {
  id:string;
  date:string;
  title:string;
  absences:string[];
  benches:string[];
};
type Risk = {
  category:'Raid buff' | 'Raid debuff' | 'Group buff';
  name:string;
  detail:string;
  level:'missing' | 'risk' | 'assignment';
};
type DraggedPlayer = { bucket:number; index:number };
type BenchSuggestion = { players:string[]; score:number; risks:Risk[]; reasons:string[]; assignments:string[] };

const STORAGE = 'tbc-raid-risk-profile-v2';
const EMPTY_GROUPS:string[][] = [[], [], [], [], [], []];

const normalize = (value:string) => value.trim().toLowerCase();
const isClass = (player:RosterPlayer, className:string) => normalize(player.class) === normalize(className);
const isSpec = (player:RosterPlayer, spec:string) => normalize(player.spec) === normalize(spec);
const isHealer = (player:RosterPlayer) => normalize(player.role).includes('heal');
const isSpedSilent = (player:RosterPlayer) => ['spedsilent', 'silent'].includes(normalize(player.name));

function validateRoster(input:unknown):RosterPlayer[] {
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { players?:unknown[] }).players)
      ? (input as { players:unknown[] }).players
      : null;

  if (!rows) throw new Error('Expected a JSON array or an object with a "players" array.');

  const players = rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`Player ${index + 1} is not an object.`);
    const player = row as Partial<RosterPlayer>;
    if (!player.name || !player.class || !player.spec || !player.role) {
      throw new Error(`Player ${index + 1} needs name, class, spec, and role.`);
    }
    return {
      name:String(player.name).trim(),
      class:String(player.class).trim(),
      spec:String(player.spec).trim(),
      role:String(player.role).trim(),
      benchEligible:player.benchEligible !== false,
      eligibleSpecs:Array.isArray(player.eligibleSpecs) ? player.eligibleSpecs.map(String) : undefined,
      curse:player.curse ? String(player.curse) : undefined,
    };
  });

  const names = new Set<string>();
  for (const player of players) {
    const key = normalize(player.name);
    if (names.has(key)) throw new Error(`Duplicate player name: ${player.name}`);
    names.add(key);
  }
  return players;
}

function freshBuckets(roster:RosterPlayer[]) {
  const buckets = EMPTY_GROUPS.map(() => [] as string[]);
  roster.forEach((player, index) => buckets[index < 25 ? Math.floor(index / 5) : 5].push(player.name));
  return buckets;
}

function fairnessPool(player:RosterPlayer):RolePool {
  if (isSpedSilent(player) || player.benchEligible === false) return 'fixed';
  return isHealer(player) ? 'healer' : 'dps';
}

function raidRisks(active:RosterPlayer[], groups:RosterPlayer[][]):Risk[] {
  const risks:Risk[] = [];
  const add = (category:Risk['category'], name:string, detail:string, level:Risk['level'] = 'missing') =>
    risks.push({ category, name, detail, level });
  const countClass = (name:string) => active.filter(player => isClass(player, name)).length;
  const hasClass = (name:string) => countClass(name) > 0;
  const hasSpec = (className:string, spec:string) => active.some(player => isClass(player, className) && isSpec(player, spec));

  if (!hasClass('Druid')) add('Raid buff', 'Mark of the Wild', 'No active Druid.');
  if (!hasClass('Priest')) add('Raid buff', 'Power Word: Fortitude', 'No active Priest.');
  if (!hasSpec('Priest', 'Discipline')) add('Raid buff', 'Divine Spirit', 'No active Discipline Priest.');
  if (!hasClass('Mage')) add('Raid buff', 'Arcane Intellect', 'No active Mage.');
  const paladins = countClass('Paladin');
  if (paladins === 0) add('Raid buff', 'Paladin blessings', 'Kings, Might, Wisdom, and Salvation are unavailable.');
  else if (paladins < 3) add('Raid buff', 'Paladin blessing coverage', `${paladins} active Paladin${paladins === 1 ? '' : 's'}; three are generally sufficient.`, 'risk');

  const warriors = countClass('Warrior');
  const rogues = countClass('Rogue');
  if (warriors === 0 && rogues === 0) {
    add('Raid debuff', 'Major armor debuff', 'No Rogue for Improved Expose Armor and no Warrior for Sunder Armor.');
  } else if (rogues === 0 && warriors === 1) {
    add('Raid debuff', 'Major armor debuff at risk', 'Only one Warrior can maintain Sunder Armor; two Warriors are strongly preferred.', 'risk');
  }
  if (!hasSpec('Druid', 'Balance')) add('Raid debuff', 'Improved Faerie Fire', 'Missing +3% melee/ranged hit.');
  if (!hasSpec('Paladin', 'Retribution')) add('Raid debuff', 'Improved Judgement of the Crusader', 'Missing +3% raid crit.');
  if (!hasSpec('Warrior', 'Arms')) add('Raid debuff', 'Blood Frenzy', 'No active Arms Warrior.');
  if (!hasSpec('Druid', 'Feral')) add('Raid debuff', 'Mangle', 'No active Feral Druid.');
  if (!hasSpec('Priest', 'Shadow')) add('Raid debuff', 'Misery / Shadow Weaving', 'No active Shadow Priest.');

  const hunters = active.filter(player => isClass(player, 'Hunter'));
  if (!hunters.length) add('Raid debuff', 'Expose Weakness / Improved Hunter’s Mark', 'No active Hunter.');
  else if (!hunters.some(player => isSpec(player, 'Survival'))) {
    add('Raid debuff', 'Survival Hunter assignment', 'Assign one active Hunter to Survival for Expose Weakness and Improved Hunter’s Mark.', 'assignment');
  }

  const warlocks = active.filter(player => isClass(player, 'Warlock'));
  if (!warlocks.length) {
    add('Raid debuff', 'Warlock curses', 'Curse of Elements, Curse of Recklessness, and Improved Shadow Bolt are unavailable.');
  } else {
    const datalus = warlocks.find(player => normalize(player.name) === 'datalus');
    const affliction = warlocks.find(player => isSpec(player, 'Affliction'));
    if (datalus && !isSpec(datalus, 'Affliction')) {
      add('Raid debuff', 'Datalus assignment', 'Datalus should be Affliction and cover Curse of Elements.', 'assignment');
    } else if (!affliction) {
      add('Raid debuff', 'Affliction / Curse of Elements assignment', 'Assign an active Warlock to Affliction and Curse of Elements.', 'assignment');
    }
    if (!warlocks.some(player => normalize(player.curse ?? '') === 'cor')) {
      add('Raid debuff', 'Curse of Recklessness assignment', 'Assign a separate active Warlock to Curse of Recklessness.', 'assignment');
    }
  }

  if (!active.some(player => isClass(player, 'Paladin') && ['holy', 'protection'].includes(normalize(player.spec)))) {
    add('Raid debuff', 'Judgement of Wisdom', 'Requires an active Holy or Protection Paladin.');
  }

  groups.forEach((group, index) => {
    const damage = group.filter(player => !isHealer(player));
    const melee = damage.filter(player => ['warrior', 'rogue', 'paladin', 'shaman', 'druid'].includes(normalize(player.class)));
    const casters = damage.filter(player => ['mage', 'warlock', 'priest', 'druid', 'shaman'].includes(normalize(player.class)));
    const huntersInGroup = damage.filter(player => isClass(player, 'Hunter'));
    const label = `Group ${index + 1}`;

    if (melee.length >= 2 && !group.some(player => isSpec(player, 'Enhancement'))) {
      add('Group buff', `${label}: Windfury`, `Melee group has ${melee.map(player => player.name).join(', ')} but no Enhancement Shaman.`, 'risk');
    }
    if (casters.length >= 2 && !group.some(player => isSpec(player, 'Elemental'))) {
      add('Group buff', `${label}: Totem of Wrath`, `Caster group has ${casters.map(player => player.name).join(', ')} but no Elemental Shaman.`, 'risk');
    }
    if (casters.length >= 2 && !group.some(player => isSpec(player, 'Balance'))) {
      add('Group buff', `${label}: Moonkin Aura`, 'Caster group is missing a Balance Druid.', 'risk');
    }
    if ((melee.length + huntersInGroup.length) >= 3 && !group.some(player => isSpec(player, 'Feral'))) {
      add('Group buff', `${label}: Leader of the Pack`, 'Physical group is missing a Feral Druid.', 'risk');
    }
    if (huntersInGroup.length >= 2 && !group.some(player => isSpec(player, 'Beast Mastery'))) {
      add('Group buff', `${label}: Ferocious Inspiration`, 'Hunter group is missing a Beast Mastery Hunter.', 'risk');
    }
    if (casters.length >= 2 && !group.some(player => isSpec(player, 'Shadow'))) {
      add('Group buff', `${label}: Vampiric Touch`, 'Mana-dependent caster group is missing a Shadow Priest.', 'risk');
    }
  });

  return risks;
}

function combinations<T>(items:T[], size:number, limit = 100000) {
  const result:T[][] = [];
  const visit = (start:number, picked:T[]) => {
    if (result.length >= limit) return;
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index <= items.length - (size - picked.length); index += 1) {
      picked.push(items[index]);
      visit(index + 1, picked);
      picked.pop();
      if (result.length >= limit) return;
    }
  };
  visit(0, []);
  return result;
}

function suggestBenches(
  roster:RosterPlayer[],
  buckets:string[][],
  absences:Set<string>,
  benchCounts:Record<string,number>,
  raids:Raid[],
  selectedRaid?:Raid,
):BenchSuggestion[] {
  if (!selectedRaid) return [];
  const available = roster.filter(player => !absences.has(player.name));
  const required = Math.max(0, available.length - 25);
  if (!required) return [];

  const eligible = available.filter(player => fairnessPool(player) !== 'fixed');
  if (eligible.length < required) return [];
  const priorRaids = raids.filter(raid => raid.date < selectedRaid.date).sort((a,b) => b.date.localeCompare(a.date));
  const lastBench = new Set(priorRaids[0]?.benches ?? []);
  const groupByPlayer = new Map<string,number>();
  buckets.forEach((group, index) => group.forEach(name => groupByPlayer.set(name, index)));
  const poolMinimum = (player:RosterPlayer) => {
    const pool = fairnessPool(player);
    const peers = eligible.filter(candidate => fairnessPool(candidate) === pool);
    return peers.length ? Math.min(...peers.map(candidate => benchCounts[candidate.name] ?? 0)) : 0;
  };

  return combinations(eligible, required).map(candidatePlayers => {
    const candidateNames = new Set(candidatePlayers.map(player => player.name));
    const active = available.filter(player => !candidateNames.has(player.name));
    const groups = buckets.slice(0, 5).map(group => group
      .filter(name => !absences.has(name) && !candidateNames.has(name))
      .map(name => roster.find(player => player.name === name))
      .filter(Boolean) as RosterPlayer[]);
    const risks = raidRisks(active, groups);
    let score = 0;
    const reasons:string[] = [];

    for (const risk of risks) {
      const hardCoverage = risk.category === 'Raid buff' && risk.level === 'missing'
        || risk.name.includes('Major armor')
        || risk.name.includes('Expose Weakness')
        || risk.name === 'Warlock curses';
      if (risk.level === 'assignment') score += 35;
      else if (hardCoverage) score += 10000;
      else if (risk.category === 'Group buff') score += 140;
      else if (risk.level === 'missing') score += 5000;
      else score += 350;
    }

    const healerTarget = Math.min(5, available.filter(isHealer).length);
    const tankTarget = Math.min(2, available.filter(player => normalize(player.role).includes('tank')).length);
    if (active.filter(isHealer).length < healerTarget) { score += 10000; reasons.push(`Drops below ${healerTarget} healers`); }
    if (active.filter(player => normalize(player.role).includes('tank')).length < tankTarget) { score += 10000; reasons.push(`Drops below ${tankTarget} tanks`); }

    const paladinsSat = candidatePlayers.filter(player => isClass(player, 'Paladin')).length;
    if (paladinsSat >= 2) { score += 10000; reasons.push('Sits two Paladins'); }
    const grouped = new Map<number,number>();
    candidatePlayers.forEach(player => {
      const group = groupByPlayer.get(player.name);
      if (group != null && group < 5) grouped.set(group, (grouped.get(group) ?? 0) + 1);
      const count = benchCounts[player.name] ?? 0;
      const minimum = poolMinimum(player);
      score += count * 110;
      if (count > minimum) { score += 2500; reasons.push(`${player.name} has already sat more than the minimum in the ${fairnessPool(player)} pool`); }
      if (lastBench.has(player.name)) { score += 500; reasons.push(`${player.name} sat the previous raid`); }
      if (groupByPlayer.get(player.name) === 5) score -= 30;
    });
    grouped.forEach(count => { if (count >= 2) score += (count - 1) * 180; });

    const assignments:string[] = [];
    const hunters = active.filter(player => isClass(player, 'Hunter'));
    const warlocks = active.filter(player => isClass(player, 'Warlock'));
    if (hunters.length) assignments.push(hunters.some(player => isSpec(player, 'Survival')) ? 'Survival Hunter remains assigned' : 'Assign one active Hunter to Survival');
    if (warlocks.length) {
      const datalus = warlocks.find(player => normalize(player.name) === 'datalus');
      assignments.push(datalus ? 'Assign Datalus to Affliction + Curse of Elements' : 'Assign one active Warlock to Affliction + Curse of Elements');
      if (warlocks.length >= 2) assignments.push('Assign a separate Warlock to Curse of Recklessness');
    }
    if (!reasons.length) reasons.push('Respects current fairness round and role minimums');
    return { players:candidatePlayers.map(player => player.name), score, risks, reasons:[...new Set(reasons)], assignments };
  }).sort((a,b) => a.score - b.score || a.players.join().localeCompare(b.players.join())).slice(0, 3);
}

export default function RaidRiskAssessmentProfile() {
  const [tab, setTab] = useState<Tab>('planner');
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [buckets, setBuckets] = useState<string[][]>(EMPTY_GROUPS);
  const [raids, setRaids] = useState<Raid[]>([]);
  const [selectedRaidId, setSelectedRaidId] = useState('');
  const [benchCounts, setBenchCounts] = useState<Record<string,number>>({});
  const [dragged, setDragged] = useState<DraggedPlayer | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [newRaidDate, setNewRaidDate] = useState('');
  const [newRaidTitle, setNewRaidTitle] = useState('Tuesday Raid');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
      const savedRoster = validateRoster(saved.roster ?? []);
      setRoster(savedRoster);
      setBuckets(Array.isArray(saved.buckets) && saved.buckets.length === 6 ? saved.buckets : freshBuckets(savedRoster));
      setRaids(Array.isArray(saved.raids) ? saved.raids : []);
      setSelectedRaidId(saved.selectedRaidId ?? saved.raids?.[0]?.id ?? '');
      setBenchCounts(saved.benchCounts ?? {});
    } catch {
      localStorage.removeItem(STORAGE);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE, JSON.stringify({ roster, buckets, raids, selectedRaidId, benchCounts }));
  }, [hydrated, roster, buckets, raids, selectedRaidId, benchCounts]);

  const rosterByName = useMemo(() => new Map(roster.map(player => [player.name, player])), [roster]);
  const selectedRaid = raids.find(raid => raid.id === selectedRaidId);
  const absent = new Set(selectedRaid?.absences ?? []);
  const benched = new Set(selectedRaid?.benches ?? []);
  const activeGroups = buckets.slice(0, 5).map(group => group
    .filter(name => !absent.has(name) && !benched.has(name))
    .map(name => rosterByName.get(name))
    .filter(Boolean) as RosterPlayer[]);
  const active = roster.filter(player => !absent.has(player.name) && !benched.has(player.name));
  const risks = raidRisks(active, activeGroups);
  const benchSuggestions = useMemo(
    () => suggestBenches(roster, buckets, absent, benchCounts, raids, selectedRaid),
    [roster, buckets, selectedRaidId, selectedRaid?.absences, benchCounts, raids],
  );
  const requiredBenchCount = Math.max(0, roster.length - absent.size - 25);

  const fairness = useMemo(() => {
    const pools:Record<RolePool,RosterPlayer[]> = { dps:[], healer:[], fixed:[] };
    roster.forEach(player => pools[fairnessPool(player)].push(player));
    return pools;
  }, [roster]);

  async function uploadRoster(event:ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const next = validateRoster(JSON.parse(await file.text()));
      setRoster(next);
      setBuckets(freshBuckets(next));
      setBenchCounts({});
      setUploadError('');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not read roster JSON.');
    } finally {
      event.target.value = '';
    }
  }

  function createRaid() {
    if (!newRaidDate) return;
    const raid: Raid = { id:`raid-${newRaidDate}-${Date.now()}`, date:newRaidDate, title:newRaidTitle || 'Raid', absences:[], benches:[] };
    setRaids(current => [...current, raid].sort((a,b) => a.date.localeCompare(b.date)));
    setSelectedRaidId(raid.id);
    setTab('planner');
  }

  function updateRaid(change:Partial<Raid>) {
    if (!selectedRaid) return;
    setRaids(current => current.map(raid => raid.id === selectedRaid.id ? { ...raid, ...change } : raid));
  }

  function toggleAbsence(name:string) {
    const next = new Set(selectedRaid?.absences ?? []);
    next.has(name) ? next.delete(name) : next.add(name);
    updateRaid({ absences:[...next] });
  }

  function toggleBench(name:string) {
    if (absent.has(name)) return;
    const next = new Set(selectedRaid?.benches ?? []);
    next.has(name) ? next.delete(name) : next.add(name);
    updateRaid({ benches:[...next] });
  }

  function recordBenchFairness() {
    if (!selectedRaid) return;
    setBenchCounts(current => {
      const next = { ...current };
      selectedRaid.benches.forEach(name => { next[name] = (next[name] ?? 0) + 1; });
      return next;
    });
  }

  function applyBenchSuggestion(suggestion:BenchSuggestion) {
    updateRaid({ benches:suggestion.players });
  }

  function movePlayer(targetBucket:number, targetIndex:number) {
    if (!dragged) return;
    setBuckets(current => {
      const next = current.map(bucket => [...bucket]);
      const [player] = next[dragged.bucket].splice(dragged.index, 1);
      if (!player) return current;
      next[targetBucket].splice(Math.min(targetIndex, next[targetBucket].length), 0, player);
      return next;
    });
    setDragged(null);
  }

  return <main>
    <section className="shell">
      <header className="topbar">
        <div><p className="eyebrow">TBC raid planning</p><h1>Raid Risk Assessment Profile</h1></div>
        <nav>
          {(['planner','calendar','risk'] as Tab[]).map(item =>
            <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}
        </nav>
      </header>

      <section className="rosterUpload card">
        <div>
          <h3>Roster JSON</h3>
          <p>{roster.length ? `${roster.length} players loaded locally` : 'Upload a roster to start planning. Nothing is sent to a server.'}</p>
          {uploadError && <strong className="uploadError">{uploadError}</strong>}
        </div>
        <label className="uploadButton">Upload roster JSON<input type="file" accept=".json,application/json" onChange={uploadRoster} /></label>
        <details>
          <summary>Expected format</summary>
          <pre>{`[
  {
    "name": "Player",
    "class": "Hunter",
    "spec": "Survival",
    "role": "DPS",
    "benchEligible": true,
    "eligibleSpecs": ["Survival", "Beast Mastery"]
  }
]`}</pre>
        </details>
      </section>

      {!roster.length && <section className="emptyState card"><h2>No hardcoded roster</h2><p>Upload a roster JSON above. The first 25 players will fill Groups 1–5; additional players enter the bench pool.</p></section>}

      {roster.length > 0 && tab === 'calendar' && <section className="calendarLayout">
        <div className="card createRaid">
          <h3>Add raid week</h3>
          <label>Date<input type="date" value={newRaidDate} onChange={event => setNewRaidDate(event.target.value)} /></label>
          <label>Title<input value={newRaidTitle} onChange={event => setNewRaidTitle(event.target.value)} /></label>
          <button onClick={createRaid}>Create raid</button>
        </div>
        <div className="raidList">
          {raids.map(raid => <article className={`raidDateCard ${raid.id === selectedRaidId ? 'selected' : ''}`} key={raid.id}>
            <button onClick={() => setSelectedRaidId(raid.id)}><span>{raid.date}</span><strong>{raid.title}</strong><small>{raid.absences.length} absent · {raid.benches.length} benched</small></button>
          </article>)}
        </div>
      </section>}

      {roster.length > 0 && tab === 'planner' && <>
        <section className="plannerHeader">
          <div><h3>Compact comp planner</h3><p>Drag players between five groups and the bench. Select a raid week to apply absences and benches.</p></div>
          <select value={selectedRaidId} onChange={event => setSelectedRaidId(event.target.value)}>
            <option value="">No raid selected</option>
            {raids.map(raid => <option key={raid.id} value={raid.id}>{raid.date} · {raid.title}</option>)}
          </select>
          <button onClick={() => setBuckets(freshBuckets(roster))}>Reset from roster order</button>
        </section>

        <div className="compactCompGrid">
          {buckets.map((bucket, bucketIndex) => <section className={`compactParty ${bucketIndex === 5 ? 'compactBench' : ''}`} key={bucketIndex}>
            <h3>{bucketIndex === 5 ? 'Bench' : `Group ${bucketIndex + 1}`}</h3>
            <div className="compactSlots">
              {Array.from({ length:Math.max(5, bucket.length + 1) }, (_, index) => {
                const name = bucket[index];
                const player = name ? rosterByName.get(name) : undefined;
                return <div
                  key={`${name ?? 'empty'}-${index}`}
                  className={`compactSlot ${player ? player.class.toLowerCase() : 'empty'} ${absent.has(name) ? 'absent' : ''}`}
                  draggable={Boolean(player)}
                  onDragStart={() => player && setDragged({ bucket:bucketIndex, index })}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(event:DragEvent) => event.preventDefault()}
                  onDrop={() => movePlayer(bucketIndex, index)}
                >
                  <span className="compactClassIcon">{player?.class[0] ?? ''}</span>
                  <div>{player ? <><strong>{player.name}</strong><small>{player.spec} {player.class} · {player.role}</small></> : <span className="emptySlotLabel">Drop here</span>}</div>
                </div>;
              })}
            </div>
          </section>)}
        </div>

        {selectedRaid && <section className="benchSuggestions card">
          <div className="benchSuggestionHeader">
            <div><p className="eyebrow">Composition-aware fairness</p><h3>Suggested benches</h3><p>{requiredBenchCount ? `Choose ${requiredBenchCount} voluntary bench${requiredBenchCount === 1 ? '' : 'es'} after ${absent.size} absence${absent.size === 1 ? '' : 's'}.` : 'No voluntary benches are required for a 25-player raid.'}</p></div>
            <small>Assignments for Survival and Warlock curses are made after the bench set is chosen.</small>
          </div>
          {requiredBenchCount > 0 && benchSuggestions.length === 0 && <div className="raidWideRisk missing"><strong>No eligible combination</strong><small>There are not enough bench-eligible players after fixed players and absences are excluded.</small></div>}
          <div className="benchSuggestionGrid">
            {benchSuggestions.map((suggestion, index) => <article key={suggestion.players.join('|')} className={index === 0 ? 'recommended' : ''}>
              <span>{index === 0 ? 'Recommended' : `Alternative ${index}`}</span>
              <h4>{suggestion.players.join(' · ')}</h4>
              <small>{suggestion.risks.filter(risk => risk.level !== 'assignment').length} composition risks · {suggestion.risks.filter(risk => risk.level === 'assignment').length} assignments</small>
              <ul>{suggestion.reasons.slice(0, 3).map(reason => <li key={reason}>{reason}</li>)}</ul>
              {suggestion.assignments.length > 0 && <details><summary>Post-bench assignments</summary>{suggestion.assignments.map(item => <p key={item}>{item}</p>)}</details>}
              {suggestion.risks.length > 0 && <details><summary>Coverage impact</summary>{suggestion.risks.slice(0, 6).map(risk => <p key={`${risk.category}-${risk.name}`}><strong>{risk.name}:</strong> {risk.detail}</p>)}</details>}
              <button onClick={() => applyBenchSuggestion(suggestion)}>Use this suggestion</button>
            </article>)}
          </div>
        </section>}

        {selectedRaid && <section className="attendanceGrid">
          <article className="card"><h3>Absences</h3><p>Absences adjust the week but never count as a bench.</p><div className="benchChips">{roster.map(player => <button className={absent.has(player.name) ? 'selectedChip' : ''} key={player.name} onClick={() => toggleAbsence(player.name)}>{player.name}</button>)}</div></article>
          <article className="card"><h3>Bench</h3><p>Choose from the fairness pools. Spedsilent/Silent and bench-ineligible players are excluded.</p><div className="benchChips">{roster.filter(player => fairnessPool(player) !== 'fixed').map(player => <button disabled={absent.has(player.name)} className={benched.has(player.name) ? 'selectedChip' : ''} key={player.name} onClick={() => toggleBench(player.name)}>{player.name} · sat {benchCounts[player.name] ?? 0}x</button>)}</div><button onClick={recordBenchFairness}>Record this week’s benches</button></article>
        </section>}
      </>}

      {roster.length > 0 && tab === 'risk' && <>
        <section className="metrics">
          <article><span>Active raid</span><strong>{active.length}/25</strong><small>after bench and absences</small></article>
          <article><span>Raid-wide risks</span><strong>{risks.filter(risk => risk.category !== 'Group buff').length}</strong><small>buffs, debuffs, assignments</small></article>
          <article><span>Group risks</span><strong>{risks.filter(risk => risk.category === 'Group buff').length}</strong><small>major party buffs</small></article>
        </section>
        <section className="raidWideRiskPanel">
          <div className="raidWideRiskHeader"><div><span>Current assessment</span><strong>{selectedRaid ? `${selectedRaid.date} · ${selectedRaid.title}` : 'No raid selected'}</strong></div><small>Rules are encoded in the app; no data-folder fetches.</small></div>
          <div className="raidWideRiskColumns">
            {(['Raid buff','Raid debuff','Group buff'] as Risk['category'][]).map(category => <article key={category}>
              <h3>{category}s</h3>
              {!risks.some(risk => risk.category === category) && <div className="raidWideClear">Coverage intact.</div>}
              {risks.filter(risk => risk.category === category).map(risk => <div className={`raidWideRisk ${risk.level}`} key={`${category}-${risk.name}`}>
                <strong>{risk.name}</strong><span>{risk.level}</span><small>{risk.detail}</small>
              </div>)}
            </article>)}
          </div>
        </section>
        <section className="rotationBoard">
          <article><h3>DPS fairness pool</h3>{fairness.dps.sort((a,b) => (benchCounts[a.name] ?? 0) - (benchCounts[b.name] ?? 0)).map(player => <div className="rotationRow" key={player.name}><strong>{player.name}</strong><span>sat {benchCounts[player.name] ?? 0}x</span></div>)}</article>
          <article><h3>Healer fairness pool</h3>{fairness.healer.sort((a,b) => (benchCounts[a.name] ?? 0) - (benchCounts[b.name] ?? 0)).map(player => <div className="rotationRow" key={player.name}><strong>{player.name}</strong><span>sat {benchCounts[player.name] ?? 0}x</span></div>)}</article>
        </section>
      </>}
    </section>
  </main>;
}
