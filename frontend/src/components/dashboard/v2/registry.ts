import type { DashboardSection } from './sections';
import NeedsAttention from './sections/NeedsAttention';
import OnToday from './sections/OnToday';
import Today from './sections/Today';
import ComingUp from './sections/ComingUp';
import OpsRow from './sections/Operations';
import PipelineBlock from './sections/Pipeline';
import ActivityBlock from './sections/Activity';

/**
 * Source-of-truth registry. To add a new section:
 *   1. Build the component under sections/<YourSection>.tsx
 *   2. Push it here with a defaultOrder slot.
 *   3. (Optional) tag it as pinnable: false if it must stay at top (like Needs).
 */
export const SECTIONS: DashboardSection[] = [
  { id: 'needs',    title: 'Needs Attention', component: NeedsAttention, defaultOrder: 0, pinnable: false, width: 'full' },
  { id: 'ontoday',  title: 'On Today',        component: OnToday,        defaultOrder: 1, pinnable: true,  width: 'full' },
  { id: 'today',    title: 'Today',           component: Today,          defaultOrder: 2, pinnable: true,  width: 'full' },
  { id: 'up',       title: 'Coming Up',       component: ComingUp,       defaultOrder: 3, pinnable: true,  width: 'full' },
  { id: 'ops',      title: 'Operations',      component: OpsRow,         defaultOrder: 4, pinnable: true,  width: 'full' },
  { id: 'pipeline', title: 'Pipeline',        component: PipelineBlock,  defaultOrder: 5, pinnable: true,  width: 'full' },
  { id: 'activity', title: 'Activity',        component: ActivityBlock,  defaultOrder: 6, pinnable: true,  width: 'full' },
];
