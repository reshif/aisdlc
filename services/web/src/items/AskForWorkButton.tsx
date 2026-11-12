import { pdpResource } from '@aisdlc/contracts';
import { Guarded, useMe } from '../access';
import { Link } from '../router';

/**
 * "Ask for work" (P1-1): a link to the form, guarded by `work.request`. On a project it is that project's; elsewhere
 * (Home, Items) it is the first project `/api/me` says the person may ask on, else the fleet, so a person who may ask
 * nowhere sees it locked with the policy's reason. A hint: the bff and core ask the PDP again on submit.
 */
export function AskForWorkButton({ project }: { project?: string }) {
  const me = useMe();
  const target =
    project ?? me.actions.projects.find((p) => p.actions.includes('work.request'))?.project_id;
  const resource = target === undefined ? pdpResource.fleet() : pdpResource.project(target);
  return (
    <Guarded action="work.request" resource={resource} label="Ask for work">
      <Link
        to={
          project === undefined ? '/ask-for-work' : `/ask-for-work/${encodeURIComponent(project)}`
        }
        className="ui-btn ui-btn-primary"
      >
        Ask for work
      </Link>
    </Guarded>
  );
}
