// The admin lifecycle's shared parts (portal v2, screen map §3): the one delete experience for every object, the
// factory admin's override reason, and the calls behind them. Other squads import from here.
import './admin.css';

export { DeleteDialog, DeleteObject, deleteLabel, previewLines } from './DeleteObject';
export {
  OVERRIDE_NEEDED,
  OverrideCancelled,
  OverrideDialog,
  errorText,
  isOverrideNeeded,
  useOverride,
} from './override';
export { adminApi, adminRequest, type NewPerson, type NewTeam } from './api';
