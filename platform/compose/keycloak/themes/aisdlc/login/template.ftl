<#-- The AISDLC sign-in page frame (portal v2, the agreed sign-in look): the brand panel on the left, the card on the
     right; on a phone the panel sits on top. Every page of the login flow is drawn inside it. No external fonts or
     scripts: the page loads nothing but its own stylesheet. -->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in · AISDLC</title>
  <#if properties.styles?has_content>
    <#list properties.styles?split(' ') as style>
      <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
    </#list>
  </#if>
</head>
<body class="${bodyClass}">
  <aside class="brand" aria-label="About AISDLC">
    <div class="wordmark">AI<span>SDLC</span></div>
    <div>
      <div class="mini" aria-hidden="true">
        <div class="mrow"><span>payments-api · item 1acc</span><span class="g">Merge review</span></div>
        <div class="mtitle">Add farewell() greeting</div>
        <div class="steps"><i></i><i></i><i></i><i></i><i></i><i class="w"></i></div>
        <div class="mrow mrow-gap"><span>Checks 5/5 passed · evidence signed</span><span class="ok">ready</span></div>
        <div class="btns"><b class="ap">Approve</b><b class="rj">Request changes</b></div>
        <div class="hash">ledger #59 · fad9148b23e4…</div>
      </div>
      <h1>A governed software factory.</h1>
      <p>Agents plan, build and verify. People decide every gate and merge every PR. Every decision is signed into the ledger.</p>
      <div class="lane" aria-label="The lifecycle">
        <span>Request</span><span class="gate">Intent</span><span>Spec</span><span class="gate">Spec review</span>
        <span>Plan</span><span class="gate">Plan review</span><span>Build</span><span>Verify</span><span class="gate">You merge</span>
      </div>
    </div>
    <div class="facts">
      <div><span class="dot"></span><span><b>No status is shown until you sign in.</b></span></div>
      <div><span class="dot dot-faint"></span><span>Your role decides what you see and what you can approve.</span></div>
    </div>
  </aside>

  <main>
    <div class="card">
      <span class="env">LOCAL · KEYCLOAK</span>
      <#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
        <div class="who">
          <span>Signing in as <b id="kc-attempted-username">${auth.attemptedUsername}</b></span>
          <a id="reset-login" href="${url.loginRestartFlowUrl}">Not you?</a>
        </div>
      </#if>
      <h2 id="kc-page-title"><#nested "header"></h2>

      <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
        <div class="alert alert-${message.type}" role="alert">${kcSanitize(message.summary)?no_esc}</div>
      </#if>

      <#nested "form">

      <#if auth?has_content && auth.showTryAnotherWayLink()>
        <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
          <input type="hidden" name="tryAnotherWay" value="on"/>
          <button type="submit" class="linkish">${msg("doTryAnotherWay")}</button>
        </form>
      </#if>

      <#nested "socialProviders">

      <#if displayInfo>
        <div id="kc-info"><#nested "info"></div>
      </#if>

      <footer>
        <span>Sessions end after 12 h, or 30 min idle.</span>
        <button class="theme" type="button" id="theme-toggle">Light / dark</button>
      </footer>
    </div>
  </main>
  <script>
    (function () {
      var t = document.getElementById('theme-toggle');
      if (t) t.addEventListener('click', function () {
        var r = document.documentElement;
        var dark = r.dataset.theme ? r.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
        r.dataset.theme = dark ? 'light' : 'dark';
      });
    })();
  </script>
</body>
</html>
</#macro>
