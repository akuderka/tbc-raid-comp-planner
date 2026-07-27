'use client';

import { useEffect, useMemo, useState } from 'react';
import baselines from '../../../data/dps-baselines.json';
import buffMatrix from '../../../data/buff-matrix.json';
import debuffValues from '../../../data/debuff-values.json';
import debuffSources from '../../../data/debuff-sources.json';
import calibration from '../../../data/player-calibration.json';
import rosterData from '../../../data/roster.json';

type Tab = 'profile' | 'calendar' | 'planner' | 'risk';
type Availability = 'available' | 'tentative' | 'unknown' | 'absent';
type RiskPrototypeStatus = 'tentative' | 'absent';
type RiskPrototypeBenchRecord = { raidId:string; ranged:string[]; melee:string[]; heals:string[] };
type RaidEvent = { id:string; date:string; title:string; zone:string; note?:string };
type RosterPlayer = { name:string; class:string; spec:string; eligibleSpecs?:string[]; role:string; benchEligible:boolean; curse?:string; pair?:string };
type PlanSlot = { player:string; replaces?:string };
type RaidPlan = { groups:PlanSlot[][]; populatedAt:string };
type BenchEvent = { raidId:string; date:string; player:string; reason:'fairness'; countsTowardFairness:true };
type Raider = { player:string; className:string; spec:string; role:string; note?:string; replaces?:string };
type Contribution = { received:number; contributed:number };
type RotationRisk = { name:string; source:string; detail:string; severity:'high' | 'medium' };
type DraggedRaider = { bucket:number; slot:number };
type ProfileRaid = { id:string; date:string; label:string };
type RaidWideRisk = { category:'Raid buff' | 'Raid debuff'; name:string; detail:string; level:'missing' | 'risk' | 'assignment' };

const roster = rosterData as RosterPlayer[];
const rosterByName = new Map(roster.map(player => [player.name, player]));
const values = baselines as Record<string, number>;

const seedRaids:RaidEvent[] = [
  { id:'2026-07-21-tk-ssc', date:'2026-07-21', title:'Tuesday Raid', zone:'TK / SSC', note:'First date-driven planning snapshot.' },
  { id:'2026-07-28-tk-ssc', date:'2026-07-28', title:'Tuesday Raid', zone:'TK / SSC' },
  { id:'2026-08-04-tk-ssc', date:'2026-08-04', title:'Tuesday Raid', zone:'TK / SSC' },
];

const oldWednesdayRaidIds:Record<string, RaidEvent> = {
  '2026-07-22-tk-ssc': seedRaids[0],
  '2026-07-29-tk-ssc': seedRaids[1],
  '2026-08-05-tk-ssc': seedRaids[2],
};

const plannedGroups:string[][] = [
  ['Poohdinni','Belross','Shortcutz','Khubjorn','Vorles'],
  ['Raidiant','Drederick','Caargo','Maclaurin','Lizardblades'],
  ['Trumie','Zaddy','Voodu','Merlong','Datalus'],
  ['Tasidust','Nukum','toodles','Lanadelpray','Tubfarter'],
  ['Silent','Milkbrother','Sera','Sanctity','DevoutCoke'],
];

const riskPrototypeRotation = {
  ranged: ['Gnf','Annalhistory','Voodu','Nukumblast','Zaddybear','Datalus','Trumie','Tasidust','Tubfarter','Merlong','Lanadelprey','Jysu'],
  melee: ['Tevia','Vorles','Belross','Shortcutz','Khub','Maclaurin','Milkbrother','Lizardblades','Raidiant','Caargo','Drederick','Poohdinni'],
  heals: ['Jessakira','Devoutcoke','Toodles','Sanctity','Sera'],
};

const riskPrototypeRaids = [
  { id:'risk-2026-07-21', date:'2026-07-21', label:'Tue Jul 21' },
  { id:'risk-2026-07-28', date:'2026-07-28', label:'Tue Jul 28' },
  { id:'risk-2026-08-04', date:'2026-08-04', label:'Tue Aug 4' },
  { id:'risk-2026-08-11', date:'2026-08-11', label:'Tue Aug 11' },
  { id:'risk-2026-08-18', date:'2026-08-18', label:'Tue Aug 18' },
  { id:'risk-2026-08-25', date:'2026-08-25', label:'Tue Aug 25' },
  { id:'risk-2026-09-01', date:'2026-09-01', label:'Tue Sep 1' },
  { id:'risk-2026-09-08', date:'2026-09-08', label:'Tue Sep 8' },
];
const profileBenchPhaseStart = '2026-08-25';
const seedProfileRaids:ProfileRaid[] = riskPrototypeRaids
  .filter(raid => raid.date >= profileBenchPhaseStart)
  .map(raid => ({ ...raid, id:`profile-${raid.date}` }));

const riskPrototypeRaiders = [...new Set([...riskPrototypeRotation.ranged, ...riskPrototypeRotation.melee, ...riskPrototypeRotation.heals])].sort((a,b) => a.localeCompare(b));

const riskPrototypeAliases:Record<string,string> = {
  Annalhistory:'annalhistory',
  Devoutcoke:'DevoutCoke',
  Jessakira:'jessakira',
  Khub:'Khubjorn',
  Lanadelprey:'Lanadelpray',
  Nukumblast:'Nukum',
  Tevia:'Terevia',
  Toodles:'toodles',
  Zaddybear:'Zaddy',
};

function rosterNameForRiskPlayer(name:string) {
  const alias = riskPrototypeAliases[name] ?? name;
  return roster.find(player => player.name.toLowerCase() === alias.toLowerCase())?.name ?? alias;
}

function rotationCompositionRisks(benched:string[], statuses:Record<string, RiskPrototypeStatus>) {
  const removed = new Set([
    ...benched,
    ...Object.entries(statuses).filter(([,status]) => status === 'absent').map(([name]) => name),
  ].map(rosterNameForRiskPlayer));
  const baseGroups = basePlanGroups.map(group => group.map(slot => raiderFromSlot(slot)));
  const projectedGroups = baseGroups.map(group => group.filter(player => !removed.has(player.player)));
  const baseRaid = baseGroups.flat();
  const projectedRaid = projectedGroups.flat();
  const raidDebuffs:RotationRisk[] = [];
  const groupBuffs:RotationRisk[] = [];

  const sourcePresent = (source:{ providerSpec:string; providerOverride?:string }, players:Raider[]) =>
    players.some(player => source.providerOverride ? player.player === source.providerOverride : matrixSpec(player) === source.providerSpec);

  for (const debuff of debuffValues) {
    const sources = debuffSources.filter(source => source.debuff === debuff.debuff);
    if (!sources.length || !sources.some(source => sourcePresent(source, baseRaid)) || sources.some(source => sourcePresent(source, projectedRaid))) continue;
    const lostProviders = baseRaid
      .filter(player => sources.some(source => source.providerOverride ? player.player === source.providerOverride : matrixSpec(player) === source.providerSpec))
      .filter(player => removed.has(player.player))
      .map(player => player.player);
    raidDebuffs.push({
      name:debuff.debuff,
      source:lostProviders.join(', ') || debuff.preferredSource || 'No active provider',
      detail:`${debuff.family || 'Raid debuff'} · ${debuff.notes || 'No fallback provider remains.'}`,
      severity:debuff.family === 'Major armor' || debuff.family === 'Caster vulnerability' || debuff.family === 'Physical damage' ? 'high' : 'medium',
    });
  }

  baseGroups.forEach((baseGroup, index) => {
    const projectedGroup = projectedGroups[index];
    for (const rule of buffMatrix) {
      const baseProviders = baseGroup.filter(player => matrixSpec(player) === rule.giverSpec);
      if (!baseProviders.length || projectedGroup.some(player => matrixSpec(player) === rule.giverSpec)) continue;
      const affected = projectedGroup.filter(player => ((rule.values as Record<string,number>)[matrixSpec(player)] ?? 0) > 0);
      if (!affected.length) continue;
      const lostProviders = baseProviders.filter(player => removed.has(player.player)).map(player => player.player);
      if (!lostProviders.length) continue;
      const estimatedLoss = affected.reduce((sum, player) => sum + ((rule.values as Record<string,number>)[matrixSpec(player)] ?? 0) * receiverScale(player), 0);
      groupBuffs.push({
        name:`Group ${index + 1}: ${rule.effect}`,
        source:lostProviders.join(', '),
        detail:`Affects ${affected.map(player => player.player).join(', ')} · ~${Math.round(estimatedLoss).toLocaleString()} modeled DPS`,
        severity:estimatedLoss >= 500 ? 'high' : 'medium',
      });
    }
  });

  return { raidDebuffs, groupBuffs };
}

function absentCount(players:string[], statuses:Record<string, RiskPrototypeStatus>) {
  return players.filter(player => statuses[player] === 'absent').length;
}

function priorRiskBenchCounts(records:Record<string, RiskPrototypeBenchRecord>, selectedRaidId:string) {
  const selectedIndex = riskPrototypeRaids.findIndex(raid => raid.id === selectedRaidId);
  const priorRaidIds = new Set(riskPrototypeRaids.slice(0, Math.max(0, selectedIndex)).map(raid => raid.id));
  const counts:Record<string, number> = {};
  for (const record of Object.values(records)) {
    if (!priorRaidIds.has(record.raidId)) continue;
    for (const player of [...record.ranged, ...record.melee, ...record.heals]) counts[player] = (counts[player] ?? 0) + 1;
  }
  return counts;
}

function rotationForRaid(players:string[], priorCounts:Record<string, number>) {
  return [...players].sort((a,b) => (priorCounts[a] ?? 0) - (priorCounts[b] ?? 0) || players.indexOf(a) - players.indexOf(b));
}

function nextBenchCandidates(players:string[], statuses:Record<string, RiskPrototypeStatus>, startingBenchCount:number) {
  const neededBenchCount = Math.max(0, startingBenchCount - absentCount(players, statuses));
  return players.filter(player => statuses[player] !== 'absent').slice(0, neededBenchCount);
}

const basePlanGroups:PlanSlot[][] = plannedGroups.map(group => group.map(player => ({ player })));
const initialProfileBuckets:string[][] = [
  ...plannedGroups.map(group => [...group]),
  roster.filter(player => !new Set(plannedGroups.flat()).has(player.name)).map(player => player.name),
];
const profileRotationPools = {
  caster: ['annalhistory','Voodu','Nukum','Zaddy','Datalus','Trumie','Tasidust','Tubfarter','Merlong','Lanadelpray','Jysu','eazi'],
  melee: ['Terevia','Vorles','Belross','Shortcutz','Khubjorn','Maclaurin','Milkbrother','Lizardblades','Raidiant','Caargo','Drederick','Poohdinni'],
  healer: ['jessakira','DevoutCoke','toodles','Sanctity','Sera'],
};

function profileRotationCategory(player:string) {
  if (profileRotationPools.caster.includes(player)) return 'caster';
  if (profileRotationPools.melee.includes(player)) return 'melee';
  if (profileRotationPools.healer.includes(player)) return 'healer';
  return 'fixed';
}

const planOverrides:Record<string, Partial<Raider>> = {
  Poohdinni:{ spec:'Feral', role:'Tank/DPS' },
  Belross:{ spec:'Arms', role:'Tank/DPS', note:'Blood Frenzy' },
  Khubjorn:{ note:'Windfury' },
  Raidiant:{ spec:'Feral', role:'Tank/DPS' },
  Drederick:{ spec:'Fury', role:'Tank/DPS' },
  Lizardblades:{ note:'Grace of Air' },
  Trumie:{ note:'Totem of Wrath' },
  Zaddy:{ note:'Moonkin Aura' },
  Voodu:{ spec:'Affliction', note:'Curse of Elements' },
  Merlong:{ spec:'Destruction', note:'Curse of Recklessness' },
  Tasidust:{ spec:'Arcane' },
  Nukum:{ spec:'Arcane' },
  toodles:{ note:'Mana Tide' },
  Lanadelpray:{ note:'Vampiric Touch' },
  Tubfarter:{ note:'Vampiric Touch' },
  Maclaurin:{ spec:'Survival', note:'Expose Weakness' },
  Milkbrother:{ spec:'Beast Mastery', note:'Ferocious Inspiration' },
};

function plannedRaider(name:string):Raider {
  const player = rosterByName.get(name);
  if (!player) return { player:name, className:'Unknown', spec:'Unknown', role:'DPS' };
  const override = planOverrides[name] ?? {};
  return {
    player:name,
    className:player.class,
    spec:override.spec ?? player.spec,
    role:override.role ?? player.role,
    note:override.note,
  };
}

function raiderFromSlot(slot:PlanSlot):Raider {
  const player = rosterByName.get(slot.player);
  if (!player) return { player:slot.player, className:'Unknown', spec:'Unknown', role:'DPS', replaces:slot.replaces };

  const replacement = plannedRaider(slot.player);
  if (!slot.replaces) return replacement;

  const replaced = plannedRaider(slot.replaces);
  const eligibleSpecs = player.eligibleSpecs ?? [player.spec];
  const canCoverPlannedSpec = player.class === replaced.className && eligibleSpecs.includes(replaced.spec);
  const sameRoleFamily = roleFamily(player.role) === roleFamily(replaced.role);

  return {
    player:slot.player,
    className:player.class,
    spec:canCoverPlannedSpec ? replaced.spec : replacement.spec,
    role:sameRoleFamily ? replaced.role : replacement.role,
    note:canCoverPlannedSpec ? replaced.note : replacement.note,
    replaces:slot.replaces,
  };
}

function roleFamily(role:string) {
  if (role.includes('Healer')) return 'healer';
  if (role === 'Tank') return 'tank';
  if (role.includes('Tank')) return 'tank-dps';
  return 'dps';
}

function cloneBasePlan() {
  return basePlanGroups.map(group => group.map(slot => ({ ...slot })));
}

const attendanceProbability:Record<Availability, number> = {
  available: 1,
  tentative: 0.55,
  unknown: 0.8,
  absent: 0,
};

function playerAvailability(availability:Record<string, Availability>, player:string) {
  return availability[player] ?? 'available';
}

function playerAttendanceProbability(availability:Record<string, Availability>, player:string) {
  return attendanceProbability[playerAvailability(availability, player)];
}

function buildPopulatedPlan(absentNames:Set<string>, raidAvailability:Record<string, Availability>, benchCounts:Record<string, number>) {
  const groups = cloneBasePlan();
  const baseNames = new Set(basePlanGroups.flat().map(slot => slot.player));
  const assigned = new Set(groups.flat().map(slot => slot.player).filter(player => !absentNames.has(player)));
  const reservePool = roster
    .filter(player => !baseNames.has(player.name) && !absentNames.has(player.name))
    .sort((a,b) => Number(b.benchEligible) - Number(a.benchEligible) || a.name.localeCompare(b.name));

  const takeReplacement = (replacedName:string) => {
    const replaced = plannedRaider(replacedName);
    const replacedFamily = roleFamily(replaced.role);
    const candidates = reservePool.filter(player => !assigned.has(player.name));
    return candidates
      .map(player => {
        const eligibleSpecs = player.eligibleSpecs ?? [player.spec];
        const canCoverSpec = player.class === replaced.className && eligibleSpecs.includes(replaced.spec);
        const sameRole = roleFamily(player.role) === replacedFamily;
        const attendance = playerAttendanceProbability(raidAvailability, player.name);
        const fairnessCredit = benchCounts[player.name] ?? 0;
        const expectedDps = values[`${player.class}:${canCoverSpec ? replaced.spec : player.spec}`] ?? (player.class === 'Mage' ? values['Mage:Arcane/Fire'] : 0);
        const score =
          (canCoverSpec ? 10000 : 0) +
          (sameRole ? 2500 : 0) +
          (player.benchEligible ? 800 : 0) +
          (fairnessCredit * 650) +
          (attendance * 1000) +
          expectedDps -
          (playerAvailability(raidAvailability, player.name) === 'tentative' ? 900 : 0) -
          (playerAvailability(raidAvailability, player.name) === 'unknown' ? 300 : 0);
        return { player, score };
      })
      .sort((a,b) => b.score - a.score || a.player.name.localeCompare(b.player.name))[0]?.player;
  };

  for (const group of groups) {
    for (let i = 0; i < group.length; i += 1) {
      const slot = group[i];
      if (!absentNames.has(slot.player)) continue;

      const replacement = takeReplacement(slot.player);
      if (!replacement) continue;

      assigned.add(replacement.name);
      group[i] = { player:replacement.name, replaces:slot.player };
    }
  }

  return { groups, populatedAt:new Date().toISOString() };
}

function matrixSpec(x:Raider) {
  const specs:Record<string,string> = {
    'Druid:Feral':'feral druid',
    'Druid:Balance':'boomkin',
    'Druid:Restoration':'resto druid',
    'Hunter:Survival':'survival hunter',
    'Hunter:Beast Mastery':'beast master hunter',
    'Mage:Fire':'fire mage',
    'Mage:Arcane':'arcane mage',
    'Paladin:Retribution':'ret paladin',
    'Paladin:Protection':'prot paladin',
    'Paladin:Holy':'holy paladin',
    'Priest:Shadow':'shadow priest',
    'Priest:Holy':'holy priest',
    'Rogue:Combat':'rogue',
    'Shaman:Enhancement':'enhance shaman',
    'Shaman:Restoration':'resto shaman',
    'Shaman:Elemental':'elemental shaman',
    'Warlock:Affliction':'affliction warlock',
    'Warlock:Destruction':'destruction warlock',
    'Warrior:Arms':'arms warrior',
    'Warrior:Fury':'fury warrior',
  };
  return specs[`${x.className}:${x.spec}`] ?? `${x.spec.toLowerCase()} ${x.className.toLowerCase()}`;
}

function dps(x:Raider) {
  return values[`${x.className}:${x.spec}`] ?? (x.className === 'Mage' ? values['Mage:Arcane/Fire'] : undefined);
}

function receiverScale(x:Raider) {
  const players = calibration.players as Record<string, { scale:number }>;
  return players[x.player]?.scale ?? calibration.defaultScale;
}

function contributionModel(groups:Raider[][]) {
  const all = groups.flat();
  const result = new Map<string, Contribution>(all.map(x => [x.player, { received:0, contributed:0 }]));

  for (const group of groups) {
    for (const rule of buffMatrix) {
      const providers = group.filter(x => matrixSpec(x) === rule.giverSpec);
      if (!providers.length) continue;

      const instances = rule.stackMode === 'Cumulative' ? providers.length : 1;
      let oneInstance = 0;
      for (const target of group) {
        const gain = ((rule.values as Record<string,number>)[matrixSpec(target)] ?? 0) * receiverScale(target);
        result.get(target.player)!.received += gain * instances;
        oneInstance += gain;
      }
      if (rule.stackMode === 'Cumulative') providers.forEach(x => result.get(x.player)!.contributed += oneInstance);
      else providers.forEach(x => result.get(x.player)!.contributed += oneInstance / providers.length);
    }
  }

  const available = debuffSources.filter(source => all.some(x => source.providerOverride ? x.player === source.providerOverride : matrixSpec(x) === source.providerSpec));
  const improvedExpose = available.some(x => x.debuff === 'Improved Expose Armor');
  const activeNames = [...new Set(available.map(x => x.debuff).filter(x => !(improvedExpose && x === 'Sunder Armor')))];

  for (const name of activeNames) {
    const rule = debuffValues.find(x => x.debuff === name);
    if (!rule) continue;

    const sourceRows = available.filter(x => x.debuff === name);
    const providers = [...new Map(sourceRows.flatMap(source => all.filter(x => source.providerOverride ? x.player === source.providerOverride : matrixSpec(x) === source.providerSpec)).map(x => [x.player, x])).values()];
    let total = 0;

    for (const target of all) {
      const gain = ((rule.values as Record<string,number>)[matrixSpec(target)] ?? 0) * receiverScale(target);
      result.get(target.player)!.received += gain;
      total += gain;
    }
    providers.forEach(x => result.get(x.player)!.contributed += total / providers.length);
  }

  return result;
}

function loadJson<T>(key:string, fallback:T):T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function migrateDefaultRaids(raids:RaidEvent[]) {
  const mapped = raids.map(raid => oldWednesdayRaidIds[raid.id] ?? (raid.title === 'Wednesday Raid' ? { ...raid, title:'Tuesday Raid' } : raid));
  const byId = new Map<string, RaidEvent>();
  for (const raid of mapped) byId.set(raid.id, raid);
  return [...byId.values()].sort((a,b) => a.date.localeCompare(b.date));
}

function migrateSelectedRaidId(id:string) {
  return oldWednesdayRaidIds[id]?.id ?? id;
}

function classNameFor(player:Raider | RosterPlayer) {
  const classValue = 'className' in player ? player.className : player.class;
  return classValue.toLowerCase();
}

function benchCountMap(events:BenchEvent[]) {
  return events.reduce<Record<string, number>>((counts, event) => {
    counts[event.player] = (counts[event.player] ?? 0) + 1;
    return counts;
  }, {});
}

function roleCoverage(groups:Raider[][], raidAvailability:Record<string, Availability>) {
  const players = groups.flat();
  const expected = (predicate:(player:Raider) => boolean) => players
    .filter(predicate)
    .reduce((sum, player) => sum + playerAttendanceProbability(raidAvailability, player.player), 0);

  return [
    { label:'Tanks / tank-flex', required:2, expected:expected(player => roleFamily(player.role).includes('tank')) },
    { label:'Healers', required:4, expected:expected(player => roleFamily(player.role) === 'healer') },
    { label:'Survival hunter', required:1, expected:expected(player => player.className === 'Hunter' && player.spec === 'Survival') },
    { label:'Arms warrior', required:1, expected:expected(player => player.className === 'Warrior' && player.spec === 'Arms') },
    { label:'Affliction warlock', required:1, expected:expected(player => player.className === 'Warlock' && player.spec === 'Affliction') },
  ].map(row => ({
    ...row,
    risk: row.expected >= row.required * 0.9 ? 'low' : row.expected >= row.required * 0.6 ? 'medium' : 'high',
  }));
}

function backupPriorities(groups:Raider[][], benchCandidates:RosterPlayer[], raidAvailability:Record<string, Availability>, benchCounts:Record<string, number>) {
  const current = groups.flat();
  const missingOrRisky = roleCoverage(groups, raidAvailability).filter(row => row.risk !== 'low');
  return benchCandidates
    .map(player => {
      const eligibleSpecs = player.eligibleSpecs ?? [player.spec];
      const coverage = missingOrRisky
        .filter(risk =>
          (risk.label === 'Healers' && roleFamily(player.role) === 'healer') ||
          (risk.label === 'Tanks / tank-flex' && roleFamily(player.role).includes('tank')) ||
          (risk.label === 'Survival hunter' && player.class === 'Hunter' && eligibleSpecs.includes('Survival')) ||
          (risk.label === 'Arms warrior' && player.class === 'Warrior' && eligibleSpecs.includes('Arms')) ||
          (risk.label === 'Affliction warlock' && player.class === 'Warlock' && eligibleSpecs.includes('Affliction'))
        )
        .map(risk => risk.label);
      const attendance = playerAttendanceProbability(raidAvailability, player.name);
      const score =
        coverage.length * 3000 +
        (benchCounts[player.name] ?? 0) * 650 +
        attendance * 1000 +
        (values[`${player.class}:${player.spec}`] ?? (player.class === 'Mage' ? values['Mage:Arcane/Fire'] : 0)) -
        (current.some(slot => slot.player === player.name) ? 10000 : 0);
      return { player, coverage, attendance, score };
    })
    .sort((a,b) => b.score - a.score || a.player.name.localeCompare(b.player.name))
    .slice(0, 6);
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('profile');
  const [raids, setRaids] = useState<RaidEvent[]>(seedRaids);
  const [selectedRaidId, setSelectedRaidId] = useState(seedRaids[0].id);
  const [availability, setAvailability] = useState<Record<string, Record<string, Availability>>>({});
  const [raidPlans, setRaidPlans] = useState<Record<string, RaidPlan>>({});
  const [benchLedger, setBenchLedger] = useState<BenchEvent[]>([]);
  const [selectedRiskPrototypeRaidId, setSelectedRiskPrototypeRaidId] = useState(riskPrototypeRaids[0].id);
  const [riskPrototypeStatusesByRaid, setRiskPrototypeStatusesByRaid] = useState<Record<string, Record<string, RiskPrototypeStatus>>>({});
  const [riskPrototypeBenchRecords, setRiskPrototypeBenchRecords] = useState<Record<string, RiskPrototypeBenchRecord>>({});
  const [riskPrototypeName, setRiskPrototypeName] = useState('');
  const [riskPrototypeStatus, setRiskPrototypeStatus] = useState<RiskPrototypeStatus>('absent');
  const [profileRaids, setProfileRaids] = useState<ProfileRaid[]>(seedProfileRaids);
  const [selectedProfileRaidId, setSelectedProfileRaidId] = useState(seedProfileRaids[0].id);
  const [profileRaidPlans, setProfileRaidPlans] = useState<Record<string,string[][]>>({});
  const [profileBenchSelections, setProfileBenchSelections] = useState<Record<string,string[]>>({});
  const [profileAbsences, setProfileAbsences] = useState<Record<string,string[]>>({});
  const [newProfileRaidDate, setNewProfileRaidDate] = useState('2026-09-15');
  const [draggedRaider, setDraggedRaider] = useState<DraggedRaider | null>(null);
  const [newRaidDate, setNewRaidDate] = useState('2026-08-12');
  const [newRaidTitle, setNewRaidTitle] = useState('Tuesday Raid');

  useEffect(() => {
    setRaids(migrateDefaultRaids(loadJson('raid-optimizer:raids', seedRaids)));
    setSelectedRaidId(migrateSelectedRaidId(loadJson('raid-optimizer:selectedRaidId', seedRaids[0].id)));
    setAvailability(loadJson('raid-optimizer:availability', {}));
    setRaidPlans(loadJson('raid-optimizer:raidPlans', {}));
    setBenchLedger(loadJson('raid-optimizer:benchLedger', []));
    const oldFlatStatuses = loadJson<Record<string, RiskPrototypeStatus>>('raid-optimizer:riskPrototypeStatuses', {});
    setRiskPrototypeStatusesByRaid(loadJson('raid-optimizer:riskPrototypeStatusesByRaid', Object.keys(oldFlatStatuses).length ? { [riskPrototypeRaids[0].id]: oldFlatStatuses } : {}));
    setRiskPrototypeBenchRecords(loadJson('raid-optimizer:riskPrototypeBenchRecords', {}));
    setSelectedRiskPrototypeRaidId(loadJson('raid-optimizer:selectedRiskPrototypeRaidId', riskPrototypeRaids[0].id));
    const loadedProfileRaids = loadJson('raid-optimizer:riskProfileRaids', seedProfileRaids).filter(raid => raid.date >= profileBenchPhaseStart);
    const nextProfileRaids = loadedProfileRaids.length ? loadedProfileRaids : seedProfileRaids;
    const validProfileRaidIds = new Set(nextProfileRaids.map(raid => raid.id));
    const filterProfileRecords = <T,>(records:Record<string,T>) => Object.fromEntries(Object.entries(records).filter(([raidId]) => validProfileRaidIds.has(raidId))) as Record<string,T>;
    const loadedSelectedProfileRaidId = loadJson('raid-optimizer:selectedRiskProfileRaidId', seedProfileRaids[0].id);
    setProfileRaids(nextProfileRaids);
    setSelectedProfileRaidId(validProfileRaidIds.has(loadedSelectedProfileRaidId) ? loadedSelectedProfileRaidId : nextProfileRaids[0].id);
    const oldProfileBuckets = loadJson<string[][]>('raid-optimizer:riskProfileBuckets', initialProfileBuckets);
    setProfileRaidPlans(filterProfileRecords(loadJson('raid-optimizer:riskProfileRaidPlans', { [seedProfileRaids[0].id]:oldProfileBuckets })));
    setProfileBenchSelections(filterProfileRecords(loadJson('raid-optimizer:riskProfileBenchSelections', {})));
    setProfileAbsences(filterProfileRecords(loadJson('raid-optimizer:riskProfileAbsences', {})));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:raids', JSON.stringify(raids));
  }, [raids]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:selectedRaidId', JSON.stringify(selectedRaidId));
  }, [selectedRaidId]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:availability', JSON.stringify(availability));
  }, [availability]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:raidPlans', JSON.stringify(raidPlans));
  }, [raidPlans]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:benchLedger', JSON.stringify(benchLedger));
  }, [benchLedger]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskPrototypeStatusesByRaid', JSON.stringify(riskPrototypeStatusesByRaid));
  }, [riskPrototypeStatusesByRaid]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskPrototypeBenchRecords', JSON.stringify(riskPrototypeBenchRecords));
  }, [riskPrototypeBenchRecords]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:selectedRiskPrototypeRaidId', JSON.stringify(selectedRiskPrototypeRaidId));
  }, [selectedRiskPrototypeRaidId]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskProfileRaids', JSON.stringify(profileRaids));
  }, [profileRaids]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:selectedRiskProfileRaidId', JSON.stringify(selectedProfileRaidId));
  }, [selectedProfileRaidId]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskProfileRaidPlans', JSON.stringify(profileRaidPlans));
  }, [profileRaidPlans]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskProfileBenchSelections', JSON.stringify(profileBenchSelections));
  }, [profileBenchSelections]);

  useEffect(() => {
    window.localStorage.setItem('raid-optimizer:riskProfileAbsences', JSON.stringify(profileAbsences));
  }, [profileAbsences]);

  const selectedRaid = raids.find(raid => raid.id === selectedRaidId) ?? raids[0];
  const raidAvailability = availability[selectedRaid.id] ?? {};
  const benchCounts = benchCountMap(benchLedger);
  const absentNames = new Set(Object.entries(raidAvailability).filter(([,status]) => status === 'absent').map(([name]) => name));
  const tentativeNames = new Set(Object.entries(raidAvailability).filter(([,status]) => status === 'tentative').map(([name]) => name));
  const unknownNames = new Set(Object.entries(raidAvailability).filter(([,status]) => status === 'unknown').map(([name]) => name));
  const activePlan = raidPlans[selectedRaid.id]?.groups ?? basePlanGroups;
  const groups = activePlan.map(group => group.map(raiderFromSlot));
  const plannedNames = new Set(groups.flat().map(x => x.player));
  const availableGroups = groups.map(group => group.filter(player => !absentNames.has(player.player)));
  const contributions = contributionModel(availableGroups);
  const allAvailablePlanned = availableGroups.flat();
  const benchCandidates = roster.filter(player => !plannedNames.has(player.name) && raidAvailability[player.name] !== 'absent');
  const fairnessBench = benchCandidates.filter(player => player.benchEligible);
  const absentPlayers = roster.filter(player => raidAvailability[player.name] === 'absent');
  const tentativePlayers = roster.filter(player => raidAvailability[player.name] === 'tentative');
  const unknownPlayers = roster.filter(player => raidAvailability[player.name] === 'unknown');
  const vacancyCount = 25 - allAvailablePlanned.length;
  const known = allAvailablePlanned.map(dps).filter((x):x is number => x != null);
  const personalTotal = known.reduce((a,b) => a + b, 0);
  const receivedTotal = allAvailablePlanned.reduce((sum,x) => sum + (contributions.get(x.player)?.received ?? 0), 0);
  const total = personalTotal + receivedTotal;
  const expectedAttendance = allAvailablePlanned.reduce((sum, player) => sum + playerAttendanceProbability(raidAvailability, player.player), 0);
  const coverageRisks = roleCoverage(groups, raidAvailability);
  const riskyCoverage = coverageRisks.filter(row => row.risk !== 'low');
  const backups = backupPriorities(groups, benchCandidates, raidAvailability, benchCounts);
  const selectedRiskPrototypeRaid = riskPrototypeRaids.find(raid => raid.id === selectedRiskPrototypeRaidId) ?? riskPrototypeRaids[0];
  const riskPrototypeStatuses = riskPrototypeStatusesByRaid[selectedRiskPrototypeRaid.id] ?? {};
  const riskPrototypePriorCounts = priorRiskBenchCounts(riskPrototypeBenchRecords, selectedRiskPrototypeRaid.id);
  const riskPrototypeEffectiveRanged = rotationForRaid(riskPrototypeRotation.ranged, riskPrototypePriorCounts);
  const riskPrototypeEffectiveMelee = rotationForRaid(riskPrototypeRotation.melee, riskPrototypePriorCounts);
  const riskPrototypeEffectiveHeals = rotationForRaid(riskPrototypeRotation.heals, riskPrototypePriorCounts);
  const riskPrototypeSuggestedRanged = nextBenchCandidates(riskPrototypeEffectiveRanged, riskPrototypeStatuses, 2);
  const riskPrototypeSuggestedMelee = nextBenchCandidates(riskPrototypeEffectiveMelee, riskPrototypeStatuses, 2);
  const riskPrototypeSuggestedHealer = nextBenchCandidates(riskPrototypeEffectiveHeals, riskPrototypeStatuses, 1);
  const riskPrototypeAbsentRanged = absentCount(riskPrototypeEffectiveRanged, riskPrototypeStatuses);
  const riskPrototypeAbsentMelee = absentCount(riskPrototypeEffectiveMelee, riskPrototypeStatuses);
  const riskPrototypeAbsentHeals = absentCount(riskPrototypeEffectiveHeals, riskPrototypeStatuses);
  const riskPrototypeMarked = Object.entries(riskPrototypeStatuses).sort(([a],[b]) => a.localeCompare(b));
  const riskPrototypeCurrentRecord = riskPrototypeBenchRecords[selectedRiskPrototypeRaid.id];
  const riskPrototypeBenched = [...riskPrototypeSuggestedRanged, ...riskPrototypeSuggestedMelee, ...riskPrototypeSuggestedHealer];
  const riskPrototypeComposition = rotationCompositionRisks(riskPrototypeBenched, riskPrototypeStatuses);
  const riskPrototypeRiskCount = riskPrototypeComposition.raidDebuffs.length + riskPrototypeComposition.groupBuffs.length;
  const selectedProfileRaid = profileRaids.find(raid => raid.id === selectedProfileRaidId) ?? profileRaids[0];
  const profileBuckets = profileRaidPlans[selectedProfileRaid?.id] ?? initialProfileBuckets;
  const priorProfileRaidIds = new Set(profileRaids
    .filter(raid => raid.date >= profileBenchPhaseStart && raid.date < (selectedProfileRaid?.date ?? ''))
    .map(raid => raid.id));
  const profileBenchCounts = Object.entries(profileRaidPlans).reduce<Record<string,number>>((counts,[raidId,buckets]) => {
    if (!priorProfileRaidIds.has(raidId)) return counts;
    const absentForRaid = new Set(profileAbsences[raidId] ?? []);
    for (const player of buckets[5] ?? []) if (player && !absentForRaid.has(player)) counts[player] = (counts[player] ?? 0) + 1;
    return counts;
  }, {});
  const selectedProfileBench = profileBenchSelections[selectedProfileRaid?.id] ?? [];
  const selectedProfileAbsences = profileAbsences[selectedProfileRaid?.id] ?? [];
  const requiredBenchCount = Math.max(0, 5 - selectedProfileAbsences.length);
  const configuredOutPlayers = [...selectedProfileBench, ...selectedProfileAbsences];
  const profileWeekApplied = selectedProfileBench.length === requiredBenchCount &&
    configuredOutPlayers.every(player => (profileBuckets[5] ?? []).includes(player));
  const fairnessEligiblePlayers = roster.filter(player => player.name !== 'Silent' && !selectedProfileAbsences.includes(player.name));
  const virtualBenchCounts = fairnessEligiblePlayers.reduce<Record<string,number>>((counts,player) => {
    counts[player.name] = (profileBenchCounts[player.name] ?? 0) + Number(selectedProfileBench.includes(player.name));
    return counts;
  }, {});
  const dpsFairnessPlayers = fairnessEligiblePlayers.filter(player => profileRotationCategory(player.name) !== 'healer');
  const healerFairnessPlayers = fairnessEligiblePlayers.filter(player => profileRotationCategory(player.name) === 'healer');
  const dpsFairnessRound = dpsFairnessPlayers.length ? Math.min(...dpsFairnessPlayers.map(player => virtualBenchCounts[player.name])) : 0;
  const healerFairnessRound = healerFairnessPlayers.length ? Math.min(...healerFairnessPlayers.map(player => virtualBenchCounts[player.name])) : 0;
  const profileBenchPool = fairnessEligiblePlayers
    .filter(player => {
      const trackRound = profileRotationCategory(player.name) === 'healer' ? healerFairnessRound : dpsFairnessRound;
      return !selectedProfileBench.includes(player.name) && virtualBenchCounts[player.name] === trackRound;
    })
    .sort((a,b) => profileRotationCategory(a.name).localeCompare(profileRotationCategory(b.name)) || a.name.localeCompare(b.name));

  function setCurrentProfileBuckets(update:(current:string[][]) => string[][]) {
    if (!selectedProfileRaid) return;
    setProfileRaidPlans(current => ({
      ...current,
      [selectedProfileRaid.id]:update(current[selectedProfileRaid.id] ?? initialProfileBuckets),
    }));
  }

  function setPlayerAvailability(player:string, status:Availability) {
    setAvailability(current => ({
      ...current,
      [selectedRaid.id]: {
        ...(current[selectedRaid.id] ?? {}),
        [player]: status,
      },
    }));
  }

  function addRaid() {
    if (!newRaidDate) return;
    const id = `${newRaidDate}-${newRaidTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'raid'}`;
    const existing = raids.some(raid => raid.id === id);
    const raid = { id: existing ? `${id}-${raids.length + 1}` : id, date:newRaidDate, title:newRaidTitle || 'Raid', zone:'TK / SSC' };
    setRaids(current => [...current, raid].sort((a,b) => a.date.localeCompare(b.date)));
    setSelectedRaidId(raid.id);
    setTab('planner');
  }

  function populateRaidPlan() {
    const populated = buildPopulatedPlan(absentNames, raidAvailability, benchCounts);
    setRaidPlans(current => ({
      ...current,
      [selectedRaid.id]: populated,
    }));
    setTab('planner');
  }

  function resetRaidPlan() {
    setRaidPlans(current => {
      const next = { ...current };
      delete next[selectedRaid.id];
      return next;
    });
  }

  function recordBench() {
    const benched = benchCandidates.filter(player => player.benchEligible);
    setBenchLedger(current => {
      const withoutRaid = current.filter(event => event.raidId !== selectedRaid.id);
      return [
        ...withoutRaid,
        ...benched.map(player => ({
          raidId:selectedRaid.id,
          date:selectedRaid.date,
          player:player.name,
          reason:'fairness' as const,
          countsTowardFairness:true as const,
        })),
      ];
    });
  }

  function markRiskPrototypeStatus() {
    const player = riskPrototypeRaiders.find(name => name.toLowerCase() === riskPrototypeName.trim().toLowerCase());
    if (!player) return;
    setRiskPrototypeStatusesByRaid(current => ({
      ...current,
      [selectedRiskPrototypeRaid.id]: {
        ...(current[selectedRiskPrototypeRaid.id] ?? {}),
        [player]: riskPrototypeStatus,
      },
    }));
    setRiskPrototypeName('');
  }

  function clearRiskPrototypeStatus(player:string) {
    setRiskPrototypeStatusesByRaid(current => {
      const raidStatuses = { ...(current[selectedRiskPrototypeRaid.id] ?? {}) };
      delete raidStatuses[player];
      const next = { ...current, [selectedRiskPrototypeRaid.id]: raidStatuses };
      return next;
    });
  }

  function recordRiskPrototypeBench() {
    setRiskPrototypeBenchRecords(current => ({
      ...current,
      [selectedRiskPrototypeRaid.id]: {
        raidId:selectedRiskPrototypeRaid.id,
        ranged:riskPrototypeSuggestedRanged,
        melee:riskPrototypeSuggestedMelee,
        heals:riskPrototypeSuggestedHealer,
      },
    }));
  }

  function clearRiskPrototypeBenchRecord() {
    setRiskPrototypeBenchRecords(current => {
      const next = { ...current };
      delete next[selectedRiskPrototypeRaid.id];
      return next;
    });
  }

  function moveProfileRaider(targetBucket:number, targetSlot:number) {
    if (!draggedRaider || (draggedRaider.bucket === targetBucket && draggedRaider.slot === targetSlot)) return;
    setCurrentProfileBuckets(current => {
      const next = current.map(bucket => [...bucket]);
      const sourcePlayer = next[draggedRaider.bucket]?.[draggedRaider.slot] ?? '';
      const targetPlayer = next[targetBucket]?.[targetSlot] ?? '';
      if (!sourcePlayer) return current;
      next[targetBucket][targetSlot] = sourcePlayer;
      next[draggedRaider.bucket][draggedRaider.slot] = targetPlayer;
      return next;
    });
    setDraggedRaider(null);
  }

  function addProfileRaid() {
    if (!newProfileRaidDate || newProfileRaidDate < profileBenchPhaseStart) return;
    const id = `profile-${newProfileRaidDate}`;
    if (!profileRaids.some(raid => raid.id === id)) {
      const label = new Date(`${newProfileRaidDate}T12:00:00`).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
      setProfileRaids(current => [...current, { id, date:newProfileRaidDate, label }].sort((a,b) => a.date.localeCompare(b.date)));
    }
    setSelectedProfileRaidId(id);
  }

  function toggleProfileBenchSelection(player:string) {
    if (!selectedProfileRaid) return;
    setProfileBenchSelections(current => {
      const selected = current[selectedProfileRaid.id] ?? [];
      return {
        ...current,
        [selectedProfileRaid.id]:selected.includes(player)
          ? selected.filter(name => name !== player)
          : selected.length < requiredBenchCount ? [...selected, player] : selected,
      };
    });
  }

  function toggleProfileAbsence(player:string) {
    if (!selectedProfileRaid) return;
    const wasAbsent = selectedProfileAbsences.includes(player);
    const nextAbsences = wasAbsent ? selectedProfileAbsences.filter(name => name !== player) : [...selectedProfileAbsences, player];
    setProfileAbsences(current => ({ ...current, [selectedProfileRaid.id]:nextAbsences }));
    setProfileBenchSelections(current => ({
      ...current,
      [selectedProfileRaid.id]:(current[selectedProfileRaid.id] ?? [])
        .filter(name => name !== player)
        .slice(0, Math.max(0, 5 - nextAbsences.length)),
    }));
  }

  function applyProfileBenchPool() {
    if (selectedProfileBench.length !== requiredBenchCount) return;
    const desired = new Set([...selectedProfileBench, ...selectedProfileAbsences]);
    setCurrentProfileBuckets(current => {
      const next = current.map(bucket => [...bucket]);
      const bench = next[5];
      const outgoingBenchSlots = bench.map((player,index) => ({ player,index })).filter(row => !desired.has(row.player));
      const incoming = [...desired].filter(player => !bench.includes(player));
      incoming.forEach((player,index) => {
        const sourceBucket = next.findIndex((bucket,bucketIndex) => bucketIndex < 5 && bucket.includes(player));
        if (sourceBucket < 0) return;
        const sourceSlot = next[sourceBucket].indexOf(player);
        const outgoing = outgoingBenchSlots[index];
        if (outgoing) {
          next[sourceBucket][sourceSlot] = bench[outgoing.index];
          bench[outgoing.index] = player;
        } else {
          next[sourceBucket][sourceSlot] = '';
          bench.push(player);
        }
      });
      return next;
    });
  }

  function activeProfileBuffs(group:string[]) {
    const specs = new Set(group.filter(Boolean).map(name => matrixSpec(plannedRaider(name))));
    return [...new Set(buffMatrix.filter(rule => specs.has(rule.giverSpec)).map(rule => rule.effect))];
  }

  function missingProfileGroupBuffs(group:string[], groupIndex:number) {
    const currentRaiders = group
      .filter(name => name && !selectedProfileAbsences.includes(name))
      .map(plannedRaider);
    const baselineRaiders = plannedGroups[groupIndex].map(plannedRaider);
    return buffMatrix.flatMap(rule => {
      const baselineProviders = baselineRaiders.filter(player => matrixSpec(player) === rule.giverSpec);
      const stillCovered = currentRaiders.some(player => matrixSpec(player) === rule.giverSpec);
      if (!baselineProviders.length || stillCovered) return [];
      const affected = currentRaiders.filter(player => ((rule.values as Record<string,number>)[matrixSpec(player)] ?? 0) > 0);
      if (!affected.length) return [];
      return [{
        effect:rule.effect,
        providers:baselineProviders.map(player => player.player),
        affected:affected.map(player => player.player),
      }];
    });
  }

  function profileRaidWideRisks() {
    const active = profileBuckets
      .slice(0,5)
      .flat()
      .filter(name => name && !selectedProfileAbsences.includes(name))
      .map(plannedRaider);
    const risks:RaidWideRisk[] = [];
    const hasClass = (className:string) => active.some(player => player.className === className);
    const hasSpec = (className:string,spec:string) => active.some(player => player.className === className && player.spec === spec);
    const classCount = (className:string) => active.filter(player => player.className === className).length;
    const add = (category:RaidWideRisk['category'],name:string,detail:string,level:RaidWideRisk['level'] = 'missing') =>
      risks.push({ category,name,detail,level });

    if (!hasClass('Druid')) add('Raid buff','Mark of the Wild','No active Druid.');
    if (!hasClass('Priest')) add('Raid buff','Power Word: Fortitude','No active Priest.');
    if (!hasSpec('Priest','Discipline')) add('Raid buff','Divine Spirit','No active Discipline Priest.');
    if (!hasClass('Mage')) add('Raid buff','Arcane Intellect','No active Mage.');

    const paladinCount = classCount('Paladin');
    if (paladinCount === 0) {
      add('Raid buff','Paladin blessings','Kings, Might, Wisdom, and Salvation are unavailable.');
    } else if (paladinCount < 3) {
      add('Raid buff','Paladin blessing coverage',`${paladinCount} active Paladin${paladinCount === 1 ? '' : 's'}; full per-class Kings, Might/Wisdom, and Salvation coverage is at risk.`,'risk');
    }

    const rogueCount = classCount('Rogue');
    const warriorCount = classCount('Warrior');
    if (rogueCount === 0 && warriorCount === 0) {
      add('Raid debuff','Major armor debuff','No Rogue for Improved Expose Armor and no Warrior for Sunder Armor.');
    } else if (rogueCount === 0 && warriorCount === 1) {
      add('Raid debuff','Major armor debuff at risk','Only one Warrior is available to maintain Sunder Armor; two Warriors are preferred.','risk');
    }

    if (!hasSpec('Druid','Balance')) add('Raid debuff','Improved Faerie Fire','No active Balance Druid; the raid loses +3% physical hit.');
    if (!hasSpec('Paladin','Retribution')) add('Raid debuff','Improved Judgement of the Crusader','No active Retribution Paladin; the raid loses +3% crit.');
    if (!hasSpec('Warrior','Arms')) add('Raid debuff','Blood Frenzy','No active Arms Warrior.');
    if (!hasSpec('Druid','Feral')) add('Raid debuff','Mangle','No active Feral Druid.');
    if (!hasSpec('Priest','Shadow')) add('Raid debuff','Misery / Shadow Weaving','No active Shadow Priest.');

    const hunters = active.filter(player => player.className === 'Hunter');
    const survivalHunter = hunters.some(player => player.spec === 'Survival');
    if (!hunters.length) {
      add('Raid debuff','Expose Weakness / Improved Hunter’s Mark','No active Hunter.');
    } else if (!survivalHunter) {
      add('Raid debuff','Survival Hunter assignment','Assign one active Hunter to Survival for Expose Weakness and Improved Hunter’s Mark.','assignment');
    }

    const warlocks = active.filter(player => player.className === 'Warlock');
    if (!warlocks.length) {
      add('Raid debuff','Curse of Elements','No active Warlock.');
      add('Raid debuff','Curse of Recklessness','No active Warlock.');
      add('Raid debuff','Improved Shadow Bolt','No active Warlock.');
    } else {
      const afflictionCovered = warlocks.some(player => player.player === 'Datalus' || player.spec === 'Affliction');
      const recklessnessAssigned = warlocks.some(player => rosterByName.get(player.player)?.curse === 'CoR');
      if (!afflictionCovered) add('Raid debuff','Affliction / Curse of Elements assignment','Datalus is out; assign another active Warlock to Affliction and Curse of Elements.','assignment');
      if (!recklessnessAssigned) add('Raid debuff','Curse of Recklessness assignment','Assign one active Warlock to Curse of Recklessness.','assignment');
    }

    if (!active.some(player => player.className === 'Paladin' && (player.spec === 'Protection' || player.spec === 'Holy'))) {
      add('Raid debuff','Judgement of Wisdom','No active Protection or Holy Paladin.');
    }

    return risks;
  }

  const profileWideRisks = profileWeekApplied ? profileRaidWideRisks() : [];
  const isLegacy = tab !== 'profile';
  const pageEyebrow = tab === 'profile' ? 'New workspace' : tab === 'calendar' ? 'Schedule and constraints' : tab === 'risk' ? 'Absence and bench overlay' : 'Day-specific raid plan';
  const pageTitle = tab === 'profile' ? 'Raid Risk Assessment Profile' : tab === 'calendar' ? 'Calendar' : tab === 'risk' ? 'Risk Assessment' : `${selectedRaid.title} planner`;
  const pageSubtitle = tab === 'profile'
    ? 'A fresh foundation for building the raid profile and evaluating composition risk.'
    : tab === 'calendar'
    ? 'Create raid days, select the working date, and mark attendance constraints.'
    : tab === 'risk'
      ? 'See who is out or uncertain, compare the current bench rotation, and decide whether the comp needs to be moved around.'
      : 'This plan is filtered by the selected date’s absences and shows the resulting bench pool.';

  return <main className="appShell">
    <aside className="sidebar">
      <div className="brand">
        <span className="eyebrow">Coalition</span>
        <h1>Raid Optimizer</h1>
      </div>
      <nav className="sideNav" aria-label="Raid workspace">
        <button data-testid="tab-profile" className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}><span>Raid Risk Assessment Profile</span><small>New profile workspace</small></button>
        <button data-testid="tab-old" className={isLegacy ? 'active legacyEntry' : 'legacyEntry'} onClick={() => setTab('calendar')}><span>OLD</span><small>Calendar, planner, rotation, and prior risk tools</small></button>
      </nav>
      {isLegacy && <section className="selectedDate">
        <span>Selected raid</span>
        <strong>{selectedRaid.date}</strong>
        <small>{selectedRaid.title} · {selectedRaid.zone}</small>
      </section>}
    </aside>

    <section className="workspace">
      {isLegacy && <nav className="legacyNav" aria-label="Legacy raid tools">
        <span>OLD workspace</span>
        <div>
          <button data-testid="tab-calendar" className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}>Calendar</button>
          <button data-testid="tab-planner" className={tab === 'planner' ? 'active' : ''} onClick={() => setTab('planner')}>Raid Planner</button>
          <button data-testid="tab-risk" className={tab === 'risk' ? 'active' : ''} onClick={() => setTab('risk')}>Risk Assessment</button>
        </div>
      </nav>}
      <header className="hero">
        <div>
          <p className="eyebrow">{pageEyebrow}</p>
          <h2>{pageTitle}</h2>
          <p className="sub">{pageSubtitle}</p>
        </div>
        <span className="status">● {tab === 'profile' ? 'New profile' : selectedRaid.date}</span>
      </header>

      {tab === 'profile' && <section className="profileFoundation">
        <section className="profileCalendar">
          <div className="profileWeekStrip">
            {profileRaids.map(raid => <button
              key={raid.id}
              className={raid.id === selectedProfileRaid?.id ? 'active' : ''}
              onClick={() => setSelectedProfileRaidId(raid.id)}
            >
              <span>{raid.label}</span>
              <small>{profileRaidPlans[raid.id] ? 'Comp saved' : 'Uses base comp'}</small>
            </button>)}
          </div>
          <div className="addProfileRaid">
            <input aria-label="New weekly raid date" type="date" min={profileBenchPhaseStart} value={newProfileRaidDate} onChange={event => setNewProfileRaidDate(event.target.value)} />
            <button onClick={addProfileRaid}>Add raid</button>
          </div>
        </section>
        <section className="profileAbsenceBar">
          <div>
            <span>Absences · {selectedProfileRaid?.label}</span>
            <strong>{selectedProfileAbsences.length} out · {requiredBenchCount} bench {requiredBenchCount === 1 ? 'seat' : 'seats'} needed</strong>
          </div>
          <select aria-label="Mark raider absent" value="" onChange={event => event.target.value && toggleProfileAbsence(event.target.value)}>
            <option value="">Mark raider absent…</option>
            {roster.filter(player => !selectedProfileAbsences.includes(player.name)).map(player => <option key={player.name} value={player.name}>{player.name} · {player.role}</option>)}
          </select>
          <div className="profileAbsenceChips">
            {selectedProfileAbsences.length === 0 && <small>Full roster expected</small>}
            {selectedProfileAbsences.map(player => <button key={player} onClick={() => toggleProfileAbsence(player)}>{player} · absent ×</button>)}
          </div>
        </section>
        <section className="profileRotation">
          <div className="rotationSummary">
            <span>Fair bench pool</span>
            <strong>DPS round {dpsFairnessRound + 1} · Healer round {healerFairnessRound + 1}</strong>
            <small>Phase ledger resets Aug 25. Choose {requiredBenchCount} this week; absences reduce the requirement and never earn sit credit.</small>
          </div>
          <div className="fairnessPool">
            <div className="selectedBenchPool">
              <span>Chosen {selectedProfileBench.length}/{requiredBenchCount}</span>
              {selectedProfileBench.map(player => <button key={player} onClick={() => toggleProfileBenchSelection(player)}>{player} ×</button>)}
            </div>
            <div className="eligibleBenchPool">
              {(['caster','melee','healer'] as const).map(category => <div className="benchPoolCategory" key={category}>
                <span>{category}</span>
                <div>
                  {profileBenchPool.filter(player => profileRotationCategory(player.name) === category).map(player => <button key={player.name} className={classNameFor(player)} onClick={() => toggleProfileBenchSelection(player.name)}>
                    {player.name}<small>{profileBenchCounts[player.name] ?? 0} prior</small>
                  </button>)}
                  {!profileBenchPool.some(player => profileRotationCategory(player.name) === category) && <small>Round cleared</small>}
                </div>
              </div>)}
            </div>
          </div>
          <button disabled={selectedProfileBench.length !== requiredBenchCount} onClick={applyProfileBenchPool}>Apply week</button>
        </section>
        {profileWeekApplied && <section className="raidWideRiskPanel">
          <div className="raidWideRiskHeader">
            <div><span>Raid-wide assessment</span><strong>{profileWideRisks.length ? `${profileWideRisks.length} risks` : 'Coverage intact'}</strong></div>
            <small>Checks the active 25 after bench and absences.</small>
          </div>
          {profileWideRisks.length > 0 && <div className="raidWideRiskColumns">
            {(['Raid buff','Raid debuff'] as const).map(category => <article key={category}>
              <h3>Missing {category === 'Raid buff' ? 'raid buffs' : 'raid debuffs'}</h3>
              {profileWideRisks.filter(risk => risk.category === category).length === 0 && <div className="raidWideClear">No {category.toLowerCase()} risks.</div>}
              {profileWideRisks.filter(risk => risk.category === category).map(risk => <div className={`raidWideRisk ${risk.level}`} key={risk.name}>
                <strong>{risk.name}</strong>
                <span>{risk.level === 'assignment' ? 'Assignment needed' : risk.level === 'risk' ? 'At risk' : 'Missing'}</span>
                <small>{risk.detail}</small>
              </div>)}
            </article>)}
          </div>}
        </section>}
        <div className="profilePlannerHeader">
          <div><strong>Comp planner · {selectedProfileRaid?.label}</strong><span>Drag raiders between groups and bench</span></div>
          <button onClick={() => setCurrentProfileBuckets(() => initialProfileBuckets.map(bucket => [...bucket]))}>Reset comp</button>
        </div>
        <div className="compactCompGrid">
          {profileBuckets.map((bucket,bucketIndex) => {
            const isBench = bucketIndex === 5;
            const buffs = isBench ? [] : activeProfileBuffs(bucket.filter(player => !selectedProfileAbsences.includes(player)));
            const missingBuffs = !isBench && profileWeekApplied ? missingProfileGroupBuffs(bucket,bucketIndex) : [];
            return <section className={`compactParty ${isBench ? 'compactBench' : ''}`} key={bucketIndex}>
              <h3>{isBench ? 'Bench' : `Group ${bucketIndex + 1}`}</h3>
              <div className="compactSlots">
                {Array.from({ length:Math.max(5, bucket.length) }, (_,slotIndex) => {
                  const playerName = bucket[slotIndex] ?? '';
                  const player = rosterByName.get(playerName);
                  const isAbsent = selectedProfileAbsences.includes(playerName);
                  return <div
                    key={slotIndex}
                    className={`compactSlot ${player ? classNameFor(player) : 'empty'} ${isAbsent ? 'absent' : ''}`}
                    draggable={Boolean(player) && !isAbsent}
                    onDragStart={() => player && setDraggedRaider({ bucket:bucketIndex, slot:slotIndex })}
                    onDragEnd={() => setDraggedRaider(null)}
                    onDragOver={event => event.preventDefault()}
                    onDrop={() => moveProfileRaider(bucketIndex, slotIndex)}
                  >
                    <span className="compactClassIcon">{player?.class.slice(0, 1) ?? ''}</span>
                    <div>
                      {player ? <><strong>{player.name}</strong><small>{isAbsent ? 'Absent · no bench credit' : `${player.spec} ${player.class}`}</small></> : <span className="emptySlotLabel">Drop raider here</span>}
                    </div>
                  </div>;
                })}
              </div>
              {!isBench && <div className={`compactBuffs ${buffs.length ? '' : 'inactive'}`}>
                {buffs.length ? buffs.join(' · ') : 'No active group buffs'}
              </div>}
              {!isBench && missingBuffs.length > 0 && <div className="missingGroupBuffs">
                <span>Missing group buffs</span>
                {missingBuffs.map(risk => <div key={risk.effect}>
                  <strong>{risk.effect}</strong>
                  <small>{risk.providers.join(', ')} out · affects {risk.affected.join(', ')}</small>
                </div>)}
              </div>}
            </section>;
          })}
        </div>
      </section>}

      {tab === 'calendar' && <section className="calendarLayout">
        <div className="card createRaid">
          <h3>Add raid date</h3>
          <label>Date<input type="date" value={newRaidDate} onChange={event => setNewRaidDate(event.target.value)} /></label>
          <label>Title<input value={newRaidTitle} onChange={event => setNewRaidTitle(event.target.value)} /></label>
          <button data-testid="create-raid" onClick={addRaid}>Create and open planner</button>
        </div>

        <div className="raidList">
          {raids.map(raid => {
            const statuses = availability[raid.id] ?? {};
            const absent = Object.values(statuses).filter(status => status === 'absent').length;
            const tentative = Object.values(statuses).filter(status => status === 'tentative').length;
            const unknown = Object.values(statuses).filter(status => status === 'unknown').length;
            return <article key={raid.id} className={`raidDateCard ${raid.id === selectedRaid.id ? 'selected' : ''}`}>
              <button data-testid={`raid-${raid.id}`} onClick={() => { setSelectedRaidId(raid.id); setTab('planner'); }}>
                <span>{raid.date}</span>
                <strong>{raid.title}</strong>
                <small>{raid.zone}</small>
              </button>
              <div className="raidDateStats">
                <span>{absent} absent</span>
                <span>{tentative} tentative</span>
                <span>{unknown} unknown</span>
              </div>
            </article>;
          })}
        </div>

        <div className="card availabilityPanel">
          <h3>Availability for {selectedRaid.date}</h3>
          <p>Marking someone absent removes them from that day’s active plan. Tentative and unknown players stay in the plan, but reduce expected attendance and increase role-risk warnings.</p>
          <div className="availabilityList">
            {roster.map(player => <div key={player.name} data-testid={`availability-${player.name}`} className={`availabilityRow ${classNameFor(player)}`}>
              <div>
                <strong>{player.name}</strong>
                <small>{player.spec} {player.class} · {player.role}</small>
              </div>
              <div className="segmented">
                {(['available','tentative','unknown','absent'] as Availability[]).map(status => <button key={status} data-testid={`availability-${player.name}-${status}`} className={(raidAvailability[player.name] ?? 'available') === status ? 'active' : ''} onClick={() => setPlayerAvailability(player.name, status)}>{status}</button>)}
              </div>
            </div>)}
          </div>
        </div>
      </section>}

      {tab === 'risk' && <>
        <section className="riskRaidSelector">
          <label>Risk prototype raid
            <select data-testid="risk-raid-selector" value={selectedRiskPrototypeRaid.id} onChange={event => setSelectedRiskPrototypeRaidId(event.target.value)}>
              {riskPrototypeRaids.map(raid => <option key={raid.id} value={raid.id}>{raid.label}</option>)}
            </select>
          </label>
          <div>
            <span>Bench awareness</span>
            <strong>{Object.keys(riskPrototypePriorCounts).length} raiders benched before this raid</strong>
            <small>Suggestions favor people with fewer previous sits.</small>
          </div>
        </section>

        <section className="riskPrototypeHero">
          <article>
            <p className="eyebrow">Currently up to bench</p>
            <h3>{selectedRiskPrototypeRaid.label}: start with 2 ranged + 2 melee</h3>
            <div className="suggestedBenchGrid">
              <div><span>Ranged</span>{riskPrototypeSuggestedRanged.map(player => <strong key={player}>{player}</strong>)}<small>{riskPrototypeAbsentRanged} absent · {riskPrototypeSuggestedRanged.length}/2 sit</small></div>
              <div><span>Melee</span>{riskPrototypeSuggestedMelee.map(player => <strong key={player}>{player}</strong>)}<small>{riskPrototypeAbsentMelee} absent · {riskPrototypeSuggestedMelee.length}/2 sit</small></div>
              <div><span>Healer rotation</span>{riskPrototypeSuggestedHealer.map(player => <strong key={player}>{player}</strong>)}<small>{riskPrototypeAbsentHeals} absent · tracked independently</small></div>
            </div>
            <div className="prototypeRecordActions">
              <button data-testid="risk-prototype-record-bench" className="primaryAction" onClick={recordRiskPrototypeBench}>Record these benches</button>
              {riskPrototypeCurrentRecord && <button data-testid="risk-prototype-clear-bench" onClick={clearRiskPrototypeBenchRecord}>Clear recorded bench</button>}
              {riskPrototypeCurrentRecord && <small>Recorded: {[...riskPrototypeCurrentRecord.ranged, ...riskPrototypeCurrentRecord.melee, ...riskPrototypeCurrentRecord.heals].join(' · ') || 'No bench'}</small>}
            </div>
          </article>

          <article>
            <p className="eyebrow">Scheduled raider status</p>
            <h3>Mark tentative or absent</h3>
            <div className="prototypeStatusForm">
              <input list="risk-prototype-raiders" placeholder="Type a raider name…" value={riskPrototypeName} onChange={event => setRiskPrototypeName(event.target.value)} />
              <datalist id="risk-prototype-raiders">{riskPrototypeRaiders.map(player => <option key={player} value={player} />)}</datalist>
              <select value={riskPrototypeStatus} onChange={event => setRiskPrototypeStatus(event.target.value as RiskPrototypeStatus)}>
                <option value="absent">Absent</option>
                <option value="tentative">Tentative</option>
              </select>
              <button data-testid="risk-prototype-mark" className="primaryAction" onClick={markRiskPrototypeStatus}>Add status</button>
            </div>
            <div className="prototypeStatusChips">
              {riskPrototypeMarked.length === 0 && <span>No tentative or absent raiders marked.</span>}
              {riskPrototypeMarked.map(([player,status]) => <button key={player} className={status} onClick={() => clearRiskPrototypeStatus(player)}>{player} · {status} ×</button>)}
            </div>
          </article>
        </section>

        <section className="compositionRiskPanel" data-testid="rotation-composition-risks">
          <div className="compositionRiskHeader">
            <div>
              <p className="eyebrow">Rotation impact</p>
              <h3>Buff and debuff risk assessment</h3>
              <p>Projected from the suggested bench plus raiders marked absent. Tentative raiders are treated as attending.</p>
            </div>
            <strong className={riskPrototypeRiskCount ? 'hasRisk' : 'clear'}>{riskPrototypeRiskCount ? `${riskPrototypeRiskCount} risks` : 'Coverage intact'}</strong>
          </div>
          <div className="compositionRiskColumns">
            <article>
              <span className="riskColumnLabel">Missing raid debuffs</span>
              {riskPrototypeComposition.raidDebuffs.length === 0 && <div className="riskEmpty">All modeled raid debuffs retain a provider.</div>}
              {riskPrototypeComposition.raidDebuffs.map(risk => <div key={risk.name} className={`compositionRiskRow ${risk.severity}`}>
                <strong>{risk.name}</strong>
                <span>Lost with {risk.source}</span>
                <small>{risk.detail}</small>
              </div>)}
            </article>
            <article>
              <span className="riskColumnLabel">Groups missing major buffs</span>
              {riskPrototypeComposition.groupBuffs.length === 0 && <div className="riskEmpty">No modeled party buffs are lost from their assigned groups.</div>}
              {riskPrototypeComposition.groupBuffs.map(risk => <div key={risk.name} className={`compositionRiskRow ${risk.severity}`}>
                <strong>{risk.name}</strong>
                <span>Provider benched/absent: {risk.source}</span>
                <small>{risk.detail}</small>
              </div>)}
            </article>
          </div>
        </section>

        <section className="rotationBoard">
          <article>
            <h3>Ranged rotation</h3>
            {riskPrototypeEffectiveRanged.map((player,index) => <div key={player} className={`rotationRow ${riskPrototypeStatuses[player] ?? ''}`}>
              <strong>{index + 1}. {player}</strong>
              <span>{riskPrototypeStatuses[player] ?? (riskPrototypeSuggestedRanged.includes(player) ? 'up now' : `sat ${riskPrototypePriorCounts[player] ?? 0}x`)}</span>
            </div>)}
          </article>
          <article>
            <h3>Melee rotation</h3>
            {riskPrototypeEffectiveMelee.map((player,index) => <div key={player} className={`rotationRow ${riskPrototypeStatuses[player] ?? ''}`}>
              <strong>{index + 1}. {player}</strong>
              <span>{riskPrototypeStatuses[player] ?? (riskPrototypeSuggestedMelee.includes(player) ? 'up now' : `sat ${riskPrototypePriorCounts[player] ?? 0}x`)}</span>
            </div>)}
          </article>
          <article>
            <h3>Healer rotation</h3>
            {riskPrototypeEffectiveHeals.map((player,index) => <div key={player} className={`rotationRow ${riskPrototypeStatuses[player] ?? ''}`}>
              <strong>{index + 1}. {player}</strong>
              <span>{riskPrototypeStatuses[player] ?? (riskPrototypeSuggestedHealer.includes(player) ? 'up next' : `sat ${riskPrototypePriorCounts[player] ?? 0}x`)}</span>
            </div>)}
          </article>
        </section>
      </>}

      {tab === 'planner' && <>
        <section className="metrics">
          <article><span>Raid size</span><strong>{allAvailablePlanned.length}/25</strong><small>{vacancyCount > 0 ? `${vacancyCount} vacancy from absences` : '5 complete parties'}</small></article>
          <article><span>Expected show rate</span><strong>{expectedAttendance.toFixed(1)}</strong><small>Probability-weighted attendees</small></article>
          <article><span>Modeled raid DPS</span><strong>{Math.round(total).toLocaleString()}</strong><small>Personal + received contribution</small></article>
          <article><span>Bench / reserve</span><strong>{benchCandidates.length}</strong><small>{benchCandidates.map(x => x.name).join(' · ') || 'No available reserves'}</small></article>
          <article><span>Risk flags</span><strong>{absentPlayers.length + tentativePlayers.length + unknownNames.size + riskyCoverage.length}</strong><small>{absentPlayers.length} absent · {tentativePlayers.length} tentative · {unknownNames.size} unknown · {riskyCoverage.length} role</small></article>
        </section>

        {(absentPlayers.length > 0 || tentativePlayers.length > 0 || unknownNames.size > 0) && <section className="constraintBanner">
          {absentPlayers.length > 0 && <div><strong>Absent</strong><span>{absentPlayers.map(x => x.name).join(' · ')}</span></div>}
          {tentativePlayers.length > 0 && <div><strong>Tentative</strong><span>{tentativePlayers.map(x => x.name).join(' · ')}</span></div>}
          {unknownNames.size > 0 && <div><strong>Unknown</strong><span>{[...unknownNames].join(' · ')}</span></div>}
        </section>}

        <section className="plannerHeader">
          <div>
            <h3>Party layout</h3>
            <p>Use Populate to rebuild the day’s comp from the default raid, replacing absent players with available bench/reserve members.</p>
          </div>
          <div className="plannerActions">
            <button data-testid="populate-plan" className="primaryAction" onClick={populateRaidPlan}>Populate</button>
            <button data-testid="reset-plan" onClick={resetRaidPlan}>Reset default</button>
            <button data-testid="record-bench" onClick={recordBench}>Record bench</button>
            {raidPlans[selectedRaid.id]?.populatedAt && <small>Populated {new Date(raidPlans[selectedRaid.id].populatedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}</small>}
          </div>
        </section>

        <section className="parties">
          {groups.map((group,i) => <article className="party" key={i}>
            <header><div><span>Group</span><strong>{i + 1}</strong></div><small>{group.filter(x => !absentNames.has(x.player)).length}/5 available</small></header>
            <div className="slots">
              {group.map(x => {
                const absent = absentNames.has(x.player);
                const tentative = tentativeNames.has(x.player);
                const unknown = unknownNames.has(x.player);
                const value = absent ? undefined : dps(x);
                const c = contributions.get(x.player) ?? { received:0, contributed:0 };
                const meter = value == null ? null : value + c.received;
                const rvi = meter == null ? null : meter + c.contributed;
                const nonDamage = x.role === 'Tank' || x.role === 'Healer';
                return <div className={`raider ${classNameFor(x)} ${absent ? 'absent' : ''} ${tentative ? 'tentative' : ''} ${unknown ? 'unknownStatus' : ''}`} key={x.player}>
                  <b className="crest">{x.className[0]}</b>
                  <div className="who">
                    <div><strong>{x.player}</strong><em>{absent ? 'ABSENT' : tentative ? 'TENTATIVE' : unknown ? 'UNKNOWN' : x.role}</em></div>
                    <span>{x.spec} {x.className}</span>
                    {x.replaces && <small className="replacementNote">Subbing for {x.replaces}</small>}
                    {x.note && <small>{x.note}</small>}
                    <small>{Math.round(receiverScale(x) * 100)}% calibration · Receives +{Math.round(c.received)} · Contributes +{Math.round(c.contributed)}</small>
                  </div>
                  <div className="dps">
                    {absent ? <><strong>Out</strong><span>needs sub</span></> : nonDamage ? <><strong>N/A</strong><span>support role</span><span className="rvi">RVI utility +{Math.round(c.contributed)}</span></> : value == null ? <><strong>—</strong><span>profile needed</span><span className="rvi">utility +{Math.round(c.contributed)}</span></> : <><strong>{Math.round(meter!).toLocaleString()}</strong><span>modeled DPS</span><span className="rvi">RVI {Math.round(rvi!).toLocaleString()}</span></>}
                  </div>
                </div>;
              })}
            </div>
          </article>)}
        </section>

        <section className="benchPanel">
          <div>
            <p className="eyebrow">Available rotation</p>
            <h3>Bench / reserve for {selectedRaid.date}</h3>
            <p>These are rostered players who are not in the populated 25 and are not marked absent. Bench fairness will only count eligible bench decisions later.</p>
          </div>
          <div className="benchChips">{benchCandidates.map(x => <span key={x.name} className={classNameFor(x)}>{x.name}<small>{x.spec} {x.class}{x.benchEligible ? '' : ' · reserve'}</small></span>)}</div>
        </section>
      </>}
    </section>
  </main>;
}
