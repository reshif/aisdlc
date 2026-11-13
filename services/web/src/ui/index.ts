// The portal's component library (portal-coverage §6 step 1): plain React and CSS custom properties
// (tokens.css), every class `ui-` prefixed (ui.css). Vocabulary (gates, lanes, steps, actors) comes
// from `@aisdlc/contracts`, never re-listed here.
import './tokens.css';
import './ui.css';
import './v2.css';
import './shell.css';

export { Card, KeyValue, PageHead, Stat, Stats, type Crumb, type StatTone } from './layout';
export { Table, type Column } from './Table';
export { ActorGlyph, Chip, GateTag, Pill, laneFill, laneText, type PillTone } from './tags';
export {
  Steps,
  Tabs,
  Timeline,
  type StepMark,
  type TabDef,
  type TimelineEvent,
  type TimelineKind,
} from './sequence';
export { Drawer, Modal, ToastProvider, useToast, type ToastTone } from './overlay';
export { EmptyState, ErrorState, LockedButton } from './states';
export { useScrollable } from './scroll';

// portal v2 (the skeleton and the sign-in look)
export {
  AppShell,
  Combobox,
  CommandPalette,
  MenuButton,
  type PaletteItem,
  type ComboOption,
  type RenderLink,
  type ShellNavEntry,
  type ShellNavGroup,
} from './AppShell';
export { NavIcon } from './icons';
export { Breadcrumb, PageHeader } from './page';
export {
  ITEM_STAGES,
  NeedsYouTable,
  PropertiesPanel,
  StageStrip,
  orderNeedsYou,
  type NeedsYouKind,
  type NeedsYouRow,
  type Property,
  type StageMark,
} from './work';
export {
  DecisionRail,
  EvidenceGrid,
  VerdictPill,
  type DecisionVerb,
  type EvidenceTile,
  type RailAccess,
} from './decide';
export {
  ScoreMark,
  Scorecard,
  Stepper,
  type ScoreItem,
  type ScoreState,
  type StepState,
  type StepperStep,
} from './progress';
export { ConfirmDelete, SecretField } from './forms';
export { CodeChip, InfoTip, Term, WireTerm, type Audience } from './term';
