<#-- The sign-in form (portal v2, the agreed sign-in page, option A): company SSO first when an identity provider is
     linked to the realm, then the local account (username and password, Keycloak's own users: the factory admins'
     break-glass accounts and, on the local stack, the test people). Field ids are Keycloak's (username, password,
     kc-login), so the flow and the tests that drive it stay Keycloak's. -->
<#import "template.ftl" as layout>
<#import "test-people.ftl" as people>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password'); section>
  <#if section = "header">
    Sign in
  <#elseif section = "form">
    <p class="sub">Use your company account. A local account is only for setup and emergencies.</p>

    <#if social?? && social.providers?has_content>
      <#list social.providers as p>
        <a id="social-${p.alias}" class="btn btn-sso" href="${p.loginUrl}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.6 8 11 4.6-1.4 8-6 8-11V5l-8-3Z" stroke="currentColor" stroke-width="2"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Continue with ${p.displayName!'company SSO'}
        </a>
      </#list>
      <div class="idp">OpenID Connect · MFA as your identity provider requires</div>
      <div class="or">or use a local account</div>
    </#if>

    <#if messagesPerField.existsError('username','password')>
      <div class="alert alert-error" role="alert" id="input-error">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc} Five wrong tries lock the account for 15 minutes.</div>
    </#if>

    <#if realm.password>
      <form id="kc-form-login" action="${url.loginAction}" method="post" novalidate>
        <#if !usernameHidden??>
          <div class="field">
            <label for="username">Username</label>
            <input id="username" class="input" name="username" value="${(login.username!'')}" type="text" autofocus
                   autocomplete="username" spellcheck="false" dir="ltr"
                   aria-invalid="<#if messagesPerField.existsError('username','password')>true<#else>false</#if>"/>
          </div>
        </#if>
        <div class="field">
          <label for="password">Password</label>
          <div class="pw">
            <input id="password" class="input" name="password" type="password" autocomplete="current-password" dir="ltr"
                   aria-invalid="<#if messagesPerField.existsError('username','password')>true<#else>false</#if>"/>
            <button type="button" id="show-password" aria-controls="password">Show</button>
          </div>
        </div>
        <div class="row"><span>Forgot it? A factory admin resets local accounts.</span></div>
        <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
        <button class="btn btn-local" name="login" id="kc-login" type="submit">Sign in with local account</button>
      </form>
    </#if>

    <div class="note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span>Local accounts can set up the factory and recover access. Every sign-in is recorded, and an authenticator app (one-time codes) can be added to any account.</span>
    </div>

    <@people.testPeople/>

    <script>
      (function () {
        var p = document.getElementById('password'), b = document.getElementById('show-password');
        if (p && b) b.addEventListener('click', function () {
          var on = p.type === 'password'; p.type = on ? 'text' : 'password'; b.textContent = on ? 'Hide' : 'Show';
        });
        var u = document.getElementById('username');
        document.querySelectorAll('.people button[data-username]').forEach(function (x) {
          x.addEventListener('click', function () {
            if (u) u.value = x.getAttribute('data-username');
            if (p) p.focus();
          });
        });
      })();
    </script>
  <#elseif section = "info">
  <#elseif section = "socialProviders">
  </#if>
</@layout.registrationLayout>
