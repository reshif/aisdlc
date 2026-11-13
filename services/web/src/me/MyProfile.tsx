import { label, roleDef } from '@aisdlc/contracts';
import { useAccess } from '../access';
import { errorText } from '../admin';
import type { Me } from '../api';
import { Loading } from '../components/Notice';
import { RoleName, initials, scopeLabel, signInLabel } from '../people/shared';
import { Link } from '../router';
import { Card, PageHeader, PropertiesPanel } from '../ui';

// My profile (screen map §1.3, the avatar menu): who I am in the factory. Name and id, how I sign in, the teams and
// roles that reach me, and where to see my access and notifications. Changing a name or a sign-in is the identity
// provider's (Keycloak) or a factory admin's on People; nothing here writes.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

export function MyProfilePage({ me }: { me: Me }) {
  const q = useAccess();
  const name = me.principal.display_name;
  if (q.isPending) return <Loading what="your profile" />;
  if (q.isError)
    return (
      <p className="adm-note" role="alert">
        {errorText(q.error)}
      </p>
    );
  const inForce = q.data.bindings.filter((b) => b.blockers.length === 0);
  const teams = [
    ...new Set(
      q.data.bindings.filter((b) => b.group_id.startsWith('team.')).map((b) => b.group_display),
    ),
  ];
  return (
    <>
      <PageHeader
        title={name}
        icon={initials(name)}
        meta={`${me.principal.principal_id} · ${signInLabel('sso')}`}
        renderLink={renderLink}
      />
      <div className="ui-split">
        <div className="adm-stack">
          <Card title={`Roles in force (${inForce.length})`}>
            {inForce.length === 0 ? (
              <p className="adm-muted">
                No role yet. <Link to="/me/access#ask">Ask for one</Link>.
              </p>
            ) : (
              <ul className="adm-chips" aria-label="Roles in force">
                {inForce.map((b) => (
                  <li key={`${b.binding_id}:${b.group_id}`} className="adm-chip">
                    <RoleName id={b.role_id} def={roleDef(b.role_id)} /> · {scopeLabel(b.scope)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={label('screen', 'teams')}>
            {teams.length === 0 ? (
              <p className="adm-muted">Not in a team that holds a role.</p>
            ) : (
              <ul className="adm-chips" aria-label="Teams">
                {teams.map((t) => (
                  <li key={t} className="adm-chip">
                    {t}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Signing in">
            <p>
              You sign in with the company sign-in. Your name and password are kept there, not in
              the factory. You are signed out after 30 minutes idle and after 8 hours at most.
            </p>
          </Card>
        </div>
        <PropertiesPanel
          rows={[
            { label: 'Name', value: name },
            { label: 'Id', value: <span className="ui-mono">{me.principal.principal_id}</span> },
            { label: 'Sign-in', value: signInLabel('sso') },
            { label: 'Projects', value: q.data.projects.length },
          ]}
          actionsTitle="More about you"
          actions={
            <>
              <Link to="/me/access" className="ui-btn">
                {label('screen', 'my_access')}
              </Link>
              <Link to="/me/notifications" className="ui-btn">
                {label('screen', 'my_notifications')}
              </Link>
            </>
          }
        />
      </div>
    </>
  );
}
