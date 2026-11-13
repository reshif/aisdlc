@id("role/factory.admin/access.explain")
permit (principal in Role::"factory.admin", action == Action::"access.explain", resource);

@id("role/factory.admin/access.manage")
permit (principal in Role::"factory.admin", action == Action::"access.manage", resource);

@id("role/factory.admin/assistant.use")
permit (principal in Role::"factory.admin", action == Action::"assistant.use", resource);

@id("role/factory.admin/audit.read")
permit (principal in Role::"factory.admin", action == Action::"audit.read", resource);

@id("role/factory.admin/banner.publish")
permit (principal in Role::"factory.admin", action == Action::"banner.publish", resource);

@id("role/factory.admin/binding.delete")
permit (principal in Role::"factory.admin", action == Action::"binding.delete", resource);

@id("role/factory.admin/closeout.read")
permit (principal in Role::"factory.admin", action == Action::"closeout.read", resource);

@id("role/factory.admin/config.decide")
permit (principal in Role::"factory.admin", action == Action::"config.decide", resource);

@id("role/factory.admin/config.propose")
permit (principal in Role::"factory.admin", action == Action::"config.propose", resource);

@id("role/factory.admin/control.apply")
permit (principal in Role::"factory.admin", action == Action::"control.apply", resource);

@id("role/factory.admin/control.lift")
permit (principal in Role::"factory.admin", action == Action::"control.lift", resource);

@id("role/factory.admin/floor.read")
permit (principal in Role::"factory.admin", action == Action::"floor.read", resource);

@id("role/factory.admin/gate.view")
permit (principal in Role::"factory.admin", action == Action::"gate.view", resource);

@id("role/factory.admin/identity.admin")
permit (principal in Role::"factory.admin", action == Action::"identity.admin", resource);

@id("role/factory.admin/item.delete")
permit (principal in Role::"factory.admin", action == Action::"item.delete", resource);

@id("role/factory.admin/item.escape")
permit (principal in Role::"factory.admin", action == Action::"item.escape", resource);

@id("role/factory.admin/item.view_floor")
permit (principal in Role::"factory.admin", action == Action::"item.view_floor", resource);

@id("role/factory.admin/kill.release")
permit (principal in Role::"factory.admin", action == Action::"kill.release", resource);

@id("role/factory.admin/kill.request")
permit (principal in Role::"factory.admin", action == Action::"kill.request", resource);

@id("role/factory.admin/learn.propose")
permit (principal in Role::"factory.admin", action == Action::"learn.propose", resource);

@id("role/factory.admin/ops.read")
permit (principal in Role::"factory.admin", action == Action::"ops.read", resource);

@id("role/factory.admin/person.delete")
permit (principal in Role::"factory.admin", action == Action::"person.delete", resource);

@id("role/factory.admin/project.delete")
permit (principal in Role::"factory.admin", action == Action::"project.delete", resource);

@id("role/factory.admin/project.onboard")
permit (principal in Role::"factory.admin", action == Action::"project.onboard", resource);

@id("role/factory.admin/project.settings.edit")
permit (principal in Role::"factory.admin", action == Action::"project.settings.edit", resource);

@id("role/factory.admin/project.view")
permit (principal in Role::"factory.admin", action == Action::"project.view", resource);

@id("role/factory.admin/quality.read")
permit (principal in Role::"factory.admin", action == Action::"quality.read", resource);

@id("role/factory.admin/repo.delete")
permit (principal in Role::"factory.admin", action == Action::"repo.delete", resource);

@id("role/factory.admin/session.stop")
permit (principal in Role::"factory.admin", action == Action::"session.stop", resource);

@id("role/factory.admin/team.delete")
permit (principal in Role::"factory.admin", action == Action::"team.delete", resource);

@id("role/factory.auditor/access.explain")
permit (principal in Role::"factory.auditor", action == Action::"access.explain", resource);

@id("role/factory.auditor/assistant.use")
permit (principal in Role::"factory.auditor", action == Action::"assistant.use", resource);

@id("role/factory.auditor/audit.read")
permit (principal in Role::"factory.auditor", action == Action::"audit.read", resource);

@id("role/factory.auditor/closeout.read")
permit (principal in Role::"factory.auditor", action == Action::"closeout.read", resource);

@id("role/factory.auditor/floor.read")
permit (principal in Role::"factory.auditor", action == Action::"floor.read", resource);

@id("role/factory.auditor/gate.view")
permit (principal in Role::"factory.auditor", action == Action::"gate.view", resource);

@id("role/factory.auditor/item.view_floor")
permit (principal in Role::"factory.auditor", action == Action::"item.view_floor", resource);

@id("role/factory.auditor/ops.read")
permit (principal in Role::"factory.auditor", action == Action::"ops.read", resource);

@id("role/factory.auditor/project.view")
permit (principal in Role::"factory.auditor", action == Action::"project.view", resource);

@id("role/factory.auditor/quality.read")
permit (principal in Role::"factory.auditor", action == Action::"quality.read", resource);

@id("role/factory.onboarder/assistant.use")
permit (principal in Role::"factory.onboarder", action == Action::"assistant.use", resource);

@id("role/factory.onboarder/floor.read")
permit (principal in Role::"factory.onboarder", action == Action::"floor.read", resource);

@id("role/factory.onboarder/gate.view")
permit (principal in Role::"factory.onboarder", action == Action::"gate.view", resource);

@id("role/factory.onboarder/item.view_floor")
permit (principal in Role::"factory.onboarder", action == Action::"item.view_floor", resource);

@id("role/factory.onboarder/project.onboard")
permit (principal in Role::"factory.onboarder", action == Action::"project.onboard", resource);

@id("role/factory.onboarder/project.view")
permit (principal in Role::"factory.onboarder", action == Action::"project.view", resource);

@id("role/project.admin/access.explain")
permit (principal in Role::"project.admin", action == Action::"access.explain", resource);

@id("role/project.admin/access.manage")
permit (principal in Role::"project.admin", action == Action::"access.manage", resource);

@id("role/project.admin/assistant.use")
permit (principal in Role::"project.admin", action == Action::"assistant.use", resource);

@id("role/project.admin/audit.read")
permit (principal in Role::"project.admin", action == Action::"audit.read", resource);

@id("role/project.admin/banner.publish")
permit (principal in Role::"project.admin", action == Action::"banner.publish", resource);

@id("role/project.admin/binding.delete")
permit (principal in Role::"project.admin", action == Action::"binding.delete", resource);

@id("role/project.admin/card.decide")
permit (principal in Role::"project.admin", action == Action::"card.decide", resource);

@id("role/project.admin/closeout.read")
permit (principal in Role::"project.admin", action == Action::"closeout.read", resource);

@id("role/project.admin/config.propose")
permit (principal in Role::"project.admin", action == Action::"config.propose", resource);

@id("role/project.admin/control.apply")
permit (principal in Role::"project.admin", action == Action::"control.apply", resource);

@id("role/project.admin/control.lift")
permit (principal in Role::"project.admin", action == Action::"control.lift", resource);

@id("role/project.admin/floor.read")
permit (principal in Role::"project.admin", action == Action::"floor.read", resource);

@id("role/project.admin/gate.decide")
permit (principal in Role::"project.admin", action == Action::"gate.decide", resource)
when { resource.slot == "admin" };

@id("role/project.admin/gate.view")
permit (principal in Role::"project.admin", action == Action::"gate.view", resource);

@id("role/project.admin/item.delete")
permit (principal in Role::"project.admin", action == Action::"item.delete", resource);

@id("role/project.admin/item.escape")
permit (principal in Role::"project.admin", action == Action::"item.escape", resource);

@id("role/project.admin/item.ready")
permit (principal in Role::"project.admin", action == Action::"item.ready", resource);

@id("role/project.admin/item.release")
permit (principal in Role::"project.admin", action == Action::"item.release", resource);

@id("role/project.admin/item.view_floor")
permit (principal in Role::"project.admin", action == Action::"item.view_floor", resource);

@id("role/project.admin/kill.release")
permit (principal in Role::"project.admin", action == Action::"kill.release", resource);

@id("role/project.admin/kill.request")
permit (principal in Role::"project.admin", action == Action::"kill.request", resource);

@id("role/project.admin/learn.propose")
permit (principal in Role::"project.admin", action == Action::"learn.propose", resource);

@id("role/project.admin/ops.read")
permit (principal in Role::"project.admin", action == Action::"ops.read", resource);

@id("role/project.admin/project.delete")
permit (principal in Role::"project.admin", action == Action::"project.delete", resource);

@id("role/project.admin/project.settings.edit")
permit (principal in Role::"project.admin", action == Action::"project.settings.edit", resource);

@id("role/project.admin/project.view")
permit (principal in Role::"project.admin", action == Action::"project.view", resource);

@id("role/project.admin/quality.read")
permit (principal in Role::"project.admin", action == Action::"quality.read", resource);

@id("role/project.admin/repo.delete")
permit (principal in Role::"project.admin", action == Action::"repo.delete", resource);

@id("role/project.admin/session.stop")
permit (principal in Role::"project.admin", action == Action::"session.stop", resource);

@id("role/project.admin/work.request")
permit (principal in Role::"project.admin", action == Action::"work.request", resource);

@id("role/project.code_owner/assistant.use")
permit (principal in Role::"project.code_owner", action == Action::"assistant.use", resource);

@id("role/project.code_owner/audit.record")
permit (principal in Role::"project.code_owner", action == Action::"audit.record", resource);

@id("role/project.code_owner/card.decide")
permit (principal in Role::"project.code_owner", action == Action::"card.decide", resource);

@id("role/project.code_owner/closeout.read")
permit (principal in Role::"project.code_owner", action == Action::"closeout.read", resource);

@id("role/project.code_owner/floor.read")
permit (principal in Role::"project.code_owner", action == Action::"floor.read", resource);

@id("role/project.code_owner/gate.decide")
permit (principal in Role::"project.code_owner", action == Action::"gate.decide", resource)
when { resource.slot == "g4" };

@id("role/project.code_owner/gate.view")
permit (principal in Role::"project.code_owner", action == Action::"gate.view", resource);

@id("role/project.code_owner/item.escape")
permit (principal in Role::"project.code_owner", action == Action::"item.escape", resource);

@id("role/project.code_owner/item.unsure")
permit (principal in Role::"project.code_owner", action == Action::"item.unsure", resource);

@id("role/project.code_owner/item.view_floor")
permit (principal in Role::"project.code_owner", action == Action::"item.view_floor", resource);

@id("role/project.code_owner/project.view")
permit (principal in Role::"project.code_owner", action == Action::"project.view", resource);

@id("role/project.design_approver/assistant.use")
permit (principal in Role::"project.design_approver", action == Action::"assistant.use", resource);

@id("role/project.design_approver/card.decide")
permit (principal in Role::"project.design_approver", action == Action::"card.decide", resource);

@id("role/project.design_approver/closeout.read")
permit (principal in Role::"project.design_approver", action == Action::"closeout.read", resource);

@id("role/project.design_approver/floor.read")
permit (principal in Role::"project.design_approver", action == Action::"floor.read", resource);

@id("role/project.design_approver/gate.decide")
permit (principal in Role::"project.design_approver", action == Action::"gate.decide", resource)
when { resource.slot == "design" };

@id("role/project.design_approver/gate.view")
permit (principal in Role::"project.design_approver", action == Action::"gate.view", resource);

@id("role/project.design_approver/item.human_done")
permit (principal in Role::"project.design_approver", action == Action::"item.human_done", resource);

@id("role/project.design_approver/item.observe")
permit (principal in Role::"project.design_approver", action == Action::"item.observe", resource);

@id("role/project.design_approver/item.plan")
permit (principal in Role::"project.design_approver", action == Action::"item.plan", resource);

@id("role/project.design_approver/item.view_floor")
permit (principal in Role::"project.design_approver", action == Action::"item.view_floor", resource);

@id("role/project.design_approver/project.view")
permit (principal in Role::"project.design_approver", action == Action::"project.view", resource);

@id("role/project.exception_approver/assistant.use")
permit (principal in Role::"project.exception_approver", action == Action::"assistant.use", resource);

@id("role/project.exception_approver/card.decide")
permit (principal in Role::"project.exception_approver", action == Action::"card.decide", resource);

@id("role/project.exception_approver/closeout.read")
permit (principal in Role::"project.exception_approver", action == Action::"closeout.read", resource);

@id("role/project.exception_approver/floor.read")
permit (principal in Role::"project.exception_approver", action == Action::"floor.read", resource);

@id("role/project.exception_approver/gate.decide")
permit (principal in Role::"project.exception_approver", action == Action::"gate.decide", resource)
when { resource.slot == "x" };

@id("role/project.exception_approver/gate.view")
permit (principal in Role::"project.exception_approver", action == Action::"gate.view", resource);

@id("role/project.exception_approver/item.escape")
permit (principal in Role::"project.exception_approver", action == Action::"item.escape", resource);

@id("role/project.exception_approver/item.view_floor")
permit (principal in Role::"project.exception_approver", action == Action::"item.view_floor", resource);

@id("role/project.exception_approver/project.view")
permit (principal in Role::"project.exception_approver", action == Action::"project.view", resource);

@id("role/project.intent_approver/assistant.use")
permit (principal in Role::"project.intent_approver", action == Action::"assistant.use", resource);

@id("role/project.intent_approver/card.decide")
permit (principal in Role::"project.intent_approver", action == Action::"card.decide", resource);

@id("role/project.intent_approver/closeout.read")
permit (principal in Role::"project.intent_approver", action == Action::"closeout.read", resource);

@id("role/project.intent_approver/floor.read")
permit (principal in Role::"project.intent_approver", action == Action::"floor.read", resource);

@id("role/project.intent_approver/gate.decide")
permit (principal in Role::"project.intent_approver", action == Action::"gate.decide", resource)
when { resource.slot == "intent" };

@id("role/project.intent_approver/gate.view")
permit (principal in Role::"project.intent_approver", action == Action::"gate.view", resource);

@id("role/project.intent_approver/item.ready")
permit (principal in Role::"project.intent_approver", action == Action::"item.ready", resource);

@id("role/project.intent_approver/item.view_floor")
permit (principal in Role::"project.intent_approver", action == Action::"item.view_floor", resource);

@id("role/project.intent_approver/project.view")
permit (principal in Role::"project.intent_approver", action == Action::"project.view", resource);

@id("role/project.kill_holder/assistant.use")
permit (principal in Role::"project.kill_holder", action == Action::"assistant.use", resource);

@id("role/project.kill_holder/closeout.read")
permit (principal in Role::"project.kill_holder", action == Action::"closeout.read", resource);

@id("role/project.kill_holder/floor.read")
permit (principal in Role::"project.kill_holder", action == Action::"floor.read", resource);

@id("role/project.kill_holder/gate.view")
permit (principal in Role::"project.kill_holder", action == Action::"gate.view", resource);

@id("role/project.kill_holder/item.view_floor")
permit (principal in Role::"project.kill_holder", action == Action::"item.view_floor", resource);

@id("role/project.kill_holder/kill.release")
permit (principal in Role::"project.kill_holder", action == Action::"kill.release", resource);

@id("role/project.kill_holder/kill.request")
permit (principal in Role::"project.kill_holder", action == Action::"kill.request", resource);

@id("role/project.kill_holder/project.view")
permit (principal in Role::"project.kill_holder", action == Action::"project.view", resource);

@id("role/project.kill_holder/session.stop")
permit (principal in Role::"project.kill_holder", action == Action::"session.stop", resource);

@id("role/project.onboarding_signer/assistant.use")
permit (principal in Role::"project.onboarding_signer", action == Action::"assistant.use", resource);

@id("role/project.onboarding_signer/card.decide")
permit (principal in Role::"project.onboarding_signer", action == Action::"card.decide", resource);

@id("role/project.onboarding_signer/closeout.read")
permit (principal in Role::"project.onboarding_signer", action == Action::"closeout.read", resource);

@id("role/project.onboarding_signer/floor.read")
permit (principal in Role::"project.onboarding_signer", action == Action::"floor.read", resource);

@id("role/project.onboarding_signer/gate.decide")
permit (principal in Role::"project.onboarding_signer", action == Action::"gate.decide", resource)
when { resource.slot == "m4" };

@id("role/project.onboarding_signer/gate.view")
permit (principal in Role::"project.onboarding_signer", action == Action::"gate.view", resource);

@id("role/project.onboarding_signer/item.view_floor")
permit (principal in Role::"project.onboarding_signer", action == Action::"item.view_floor", resource);

@id("role/project.onboarding_signer/project.view")
permit (principal in Role::"project.onboarding_signer", action == Action::"project.view", resource);

@id("role/project.release_approver/assistant.use")
permit (principal in Role::"project.release_approver", action == Action::"assistant.use", resource);

@id("role/project.release_approver/card.decide")
permit (principal in Role::"project.release_approver", action == Action::"card.decide", resource);

@id("role/project.release_approver/closeout.read")
permit (principal in Role::"project.release_approver", action == Action::"closeout.read", resource);

@id("role/project.release_approver/floor.read")
permit (principal in Role::"project.release_approver", action == Action::"floor.read", resource);

@id("role/project.release_approver/gate.decide")
permit (principal in Role::"project.release_approver", action == Action::"gate.decide", resource)
when { resource.slot == "g5" };

@id("role/project.release_approver/gate.view")
permit (principal in Role::"project.release_approver", action == Action::"gate.view", resource);

@id("role/project.release_approver/item.release")
permit (principal in Role::"project.release_approver", action == Action::"item.release", resource);

@id("role/project.release_approver/item.view_floor")
permit (principal in Role::"project.release_approver", action == Action::"item.view_floor", resource);

@id("role/project.release_approver/project.view")
permit (principal in Role::"project.release_approver", action == Action::"project.view", resource);

@id("role/project.requester/assistant.use")
permit (principal in Role::"project.requester", action == Action::"assistant.use", resource);

@id("role/project.requester/card.decide")
permit (principal in Role::"project.requester", action == Action::"card.decide", resource);

@id("role/project.requester/closeout.read")
permit (principal in Role::"project.requester", action == Action::"closeout.read", resource);

@id("role/project.requester/floor.read")
permit (principal in Role::"project.requester", action == Action::"floor.read", resource);

@id("role/project.requester/gate.decide")
permit (principal in Role::"project.requester", action == Action::"gate.decide", resource)
when { resource.slot == "requesters" };

@id("role/project.requester/gate.view")
permit (principal in Role::"project.requester", action == Action::"gate.view", resource);

@id("role/project.requester/item.escape")
permit (principal in Role::"project.requester", action == Action::"item.escape", resource);

@id("role/project.requester/item.ready")
permit (principal in Role::"project.requester", action == Action::"item.ready", resource);

@id("role/project.requester/item.view_floor")
permit (principal in Role::"project.requester", action == Action::"item.view_floor", resource);

@id("role/project.requester/project.view")
permit (principal in Role::"project.requester", action == Action::"project.view", resource);

@id("role/project.requester/work.request")
permit (principal in Role::"project.requester", action == Action::"work.request", resource);

@id("role/project.security_approver/assistant.use")
permit (principal in Role::"project.security_approver", action == Action::"assistant.use", resource);

@id("role/project.security_approver/card.decide")
permit (principal in Role::"project.security_approver", action == Action::"card.decide", resource);

@id("role/project.security_approver/closeout.read")
permit (principal in Role::"project.security_approver", action == Action::"closeout.read", resource);

@id("role/project.security_approver/floor.read")
permit (principal in Role::"project.security_approver", action == Action::"floor.read", resource);

@id("role/project.security_approver/gate.decide")
permit (principal in Role::"project.security_approver", action == Action::"gate.decide", resource)
when { resource.slot == "sec" };

@id("role/project.security_approver/gate.view")
permit (principal in Role::"project.security_approver", action == Action::"gate.view", resource);

@id("role/project.security_approver/item.view_floor")
permit (principal in Role::"project.security_approver", action == Action::"item.view_floor", resource);

@id("role/project.security_approver/ops.read")
permit (principal in Role::"project.security_approver", action == Action::"ops.read", resource);

@id("role/project.security_approver/project.view")
permit (principal in Role::"project.security_approver", action == Action::"project.view", resource);

@id("role/project.security_approver/session.stop")
permit (principal in Role::"project.security_approver", action == Action::"session.stop", resource);

@id("role/project.viewer/assistant.use")
permit (principal in Role::"project.viewer", action == Action::"assistant.use", resource);

@id("role/project.viewer/floor.read")
permit (principal in Role::"project.viewer", action == Action::"floor.read", resource);

@id("role/project.viewer/gate.view")
permit (principal in Role::"project.viewer", action == Action::"gate.view", resource);

@id("role/project.viewer/item.view_floor")
permit (principal in Role::"project.viewer", action == Action::"item.view_floor", resource);

@id("role/project.viewer/project.view")
permit (principal in Role::"project.viewer", action == Action::"project.view", resource);

@id("xcut/disabled_principal_denied")
forbid (principal, action, resource)
when { principal.status != "active" };

@id("xcut/factory_admin_override")
permit (principal in Role::"factory.admin", action, resource);

@id("xcut/fleet_kill_factory_admin_only")
forbid (principal, action in [Action::"kill.request", Action::"kill.release", Action::"session.stop"], resource is Fleet)
unless { principal in Role::"factory.admin" };

@id("xcut/service_principal_never_decides")
forbid (principal, action in [Action::"gate.decide", Action::"card.decide", Action::"config.decide"], resource)
when { principal.kind == "service" };
