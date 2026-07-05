# SmartSolarEMS — Engineering Conventions

- **Runtime/PM**: Bun only (`bun install`, `bun test`, `bun run`). Never npm/yarn/pnpm.
- **No install scripts**: never add `trustedDependencies` to package.json; rely on Bun's
  default blocking of lifecycle scripts.
- **TypeScript strict**; no `any` unless unavoidable and commented.
- **Tests**: `bun test`; every module gets unit tests (`*.test.ts` next to source).
- **Git commits**: no AI/Claude attribution, no Co-Authored-By lines, no emoji. Plain
  imperative messages. (Coordinator commits; agents should NOT run git commands.)
- **DB**: Postgres + TimescaleDB via `postgres` (porsager). Schema changes only through
  SQL files in `src/db/migrations/` (numbered `NNN_name.sql`), applied by the in-repo runner.
- **Branding**: "SmartSolarEMS" in all UI headings.
- **Safety**: anything that writes to the inverter must be gated behind shadow-mode check
  and validated against min reserve SOC.
- Track project state in `progress.md` — update it when a phase completes.
