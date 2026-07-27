# TBC Raid Optimizer

Local-first prototype for planning 8-week bench rotations, absences, physical/caster week strategy, and group assignments.

## Run locally

### 1) Optimizer service
```bash
cd services/optimizer
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2) Web app
```bash
cd apps/web
npm install
npm run dev
```

Open http://localhost:3000

## Current scope

- Roster model with known players/specs
- 8-week absence grid
- Strategy scoring: physical, caster, balanced
- Bench cap: max 2 auto-benches per 8-week tranche
- Week 7 = physical parse week, Week 8 = caster parse week
- Party buff value model from current assumptions
- Debuff framework ready for WoWSims-calibrated coefficients

## Next features

- Persist edits to SQLite/Postgres
- WCL CSV importer
- Drag/drop group builder
- RaidComp/WoWSims export
- Full CP-SAT optimization using OR-Tools
