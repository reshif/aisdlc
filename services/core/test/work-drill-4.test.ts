import { SCENARIO_NAMES, registerDrill } from './work-drill-lib.js';

// The rebuild drill, part 4 of 4 (see work-drill-lib.ts for why it is split and what it checks).
registerDrill(
  'part 4',
  SCENARIO_NAMES.filter((_, i) => i % 4 === 3),
);
