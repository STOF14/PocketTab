    /**
     * ===== POCKETTAB: FULL-STACK APPLICATION LOGIC =====
     *
     * All data is stored on the server via REST API.
     * Authentication uses JWT tokens stored in localStorage.
     * Data syncs across all users and devices through the shared backend.
     *
     * API Endpoints:
    *   POST   /api/auth/household/access — Validate household login ID + code
    *   GET    /api/auth/household/members — List users in signed-in household
     *   POST   /api/auth/register      — Create user (returns JWT)
    *   POST   /api/auth/login         — Login with household access token + PIN
    *   POST   /api/auth/household/invites — Create household invite code
     *   GET    /api/requests           — List requests for current user
     *   POST   /api/requests           — Create a request
     *   PATCH  /api/requests/:id       — Accept/reject a request
     *   GET    /api/payments           — List payments for current user
     *   POST   /api/payments           — Send a payment
     *   PATCH  /api/payments/:id       — Confirm/dispute a payment
     *   GET    /api/messages?refType=&refId= — Get messages
     *   POST   /api/messages           — Send a message
     *   PATCH  /api/users/pin          — Change PIN
     */

    // ===== API HELPER =====
    var runtimeConfig = window.POCKETTAB_CONFIG || {};
    var authToken = localStorage.getItem('pt_token') || null;
    var REQUEST_TIMEOUT_MS = Number(runtimeConfig.requestTimeoutMs) || 10000;
    var MAX_SAFE_RETRIES = Number(runtimeConfig.maxSafeRetries) || 2;
    var RETRY_BASE_DELAY_MS = Number(runtimeConfig.retryBaseDelayMs) || 300;
    var CONNECTIVITY_BANNER_DISPLAY_MS = 1200;
    var connectivityBanner = document.getElementById('connectivity-banner');

    function wait(ms) {
      return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    function setConnectivityState(state, message) {
      if (!connectivityBanner) return;
      if (!state || !message) {
        connectivityBanner.className = 'connectivity-banner hidden';
        connectivityBanner.textContent = '';
        return;
      }

      connectivityBanner.className = 'connectivity-banner ' + state;
      connectivityBanner.textContent = message;
    }

    function updateConnectivityFromNavigator() {
      if (navigator.onLine) {
        setConnectivityState('online', 'Connected');
        setTimeout(function() {
          setConnectivityState(null, null);
        }, CONNECTIVITY_BANNER_DISPLAY_MS);
      } else {
        setConnectivityState('offline', 'Offline: waiting for connection...');
      }
    }

    async function fetchWithTimeout(url, opts) {
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
      try {
        return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
      } finally {
        clearTimeout(timeout);
      }
    }

    async function api(method, path, body) {
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (authToken) {
        opts.headers['Authorization'] = 'Bearer ' + authToken;
      }
      if (body) {
        opts.body = JSON.stringify(body);
      }
      var canRetry = method === 'GET';
      var lastError = null;
      var attempts = canRetry ? (MAX_SAFE_RETRIES + 1) : 1;

      for (var attempt = 0; attempt < attempts; attempt += 1) {
        try {
          var res = await fetchWithTimeout('/api' + path, opts);
          var data = null;
          var text = await res.text();
          if (text) data = JSON.parse(text);

          if (!res.ok) {
            throw new Error((data && data.error) || 'API error');
          }

          if (navigator.onLine) {
            setConnectivityState(null, null);
          }
          return data;
        } catch (err) {
          lastError = err;
          var isTimeout = err && err.name === 'AbortError';
          var networkIssue = isTimeout || (err instanceof TypeError);
          if (networkIssue) {
            setConnectivityState('offline', isTimeout ? 'Network timeout: retrying...' : 'Offline: retrying...');
          }

          if (!(canRetry && networkIssue && attempt < attempts - 1)) {
            break;
          }

          await wait(RETRY_BASE_DELAY_MS * (attempt + 1));
        }
      }

      throw new Error((lastError && lastError.message) || 'Unable to reach server');
    }

    // ===== CACHES (loaded from server) =====
    var cachedUsers = [];
    var cachedRequests = [];
    var cachedPayments = [];
    var cachedHousehold = null;

    /** Load users from server */
    async function loadUsers() {
      try {
        if (!authToken || !currentUser) {
          cachedUsers = [];
          return;
        }

        cachedUsers = await api('GET', '/auth/household/members');
      } catch (e) {
        cachedUsers = [];
      }
    }

    /** Load requests from server (requires auth) */
    async function loadRequests() {
      try {
        cachedRequests = await api('GET', '/requests');
      } catch (e) {
        cachedRequests = [];
      }
    }

    /** Load payments from server (requires auth) */
    async function loadPayments() {
      try {
        cachedPayments = await api('GET', '/payments');
      } catch (e) {
        cachedPayments = [];
      }
    }

    /** Load current household details from server (requires auth) */
    async function loadHousehold() {
      try {
        cachedHousehold = await api('GET', '/auth/household');
      } catch (e) {
        cachedHousehold = null;
      }
    }

    // ===== UTILITY FUNCTIONS =====

    /** Format amount with R prefix and two decimal places */
    function formatAmount(amount) {
      return 'R' + Number(amount).toFixed(2);
    }

    /** Format a timestamp into a readable string */
    function formatTime(ts) {
      var d = new Date(ts);
      var day = String(d.getDate()).padStart(2, '0');
      var mon = String(d.getMonth() + 1).padStart(2, '0');
      var yr = d.getFullYear();
      var hr = String(d.getHours()).padStart(2, '0');
      var min = String(d.getMinutes()).padStart(2, '0');
      return day + '/' + mon + '/' + yr + ' ' + hr + ':' + min;
    }

    /** Get user name by ID from cache */
    function getUserName(id) {
      var u = cachedUsers.find(function(u) { return u.id === id; });
      return u ? u.name : 'Unknown';
    }

    function isResolvedRequest(req) {
      return req.status === 'settled' || req.status === 'rejected';
    }

    // ===== STATE =====
    var currentUser = null;
    var selectedLoginUser = null;
    var loginHouseholdAccessToken = null;
    var loginHouseholdContext = null;
    var onboardingState = {
      step: 1,
      path: null,
      joinPreview: null
    };

    // ===== DOM REFERENCES =====
    var authScreen = document.getElementById('auth-screen');
    var appScreen = document.getElementById('app-screen');
    var authSelect = document.getElementById('auth-select');
    var authCreate = document.getElementById('auth-create');

    // ===== INITIALIZATION =====
    async function init() {
      setupEventListeners();
      updateConnectivityFromNavigator();

      // Check for existing session token
      var token = localStorage.getItem('pt_token');

      if (token) {
        authToken = token;
        try {
          currentUser = await api('GET', '/users/me');
          localStorage.setItem('pt_user', JSON.stringify(currentUser));
          enterApp();
          return;
        } catch (e) {
          authToken = null;
          localStorage.removeItem('pt_token');
          localStorage.removeItem('pt_user');
        }
      }

      showAuth();
    }

    // ===== AUTH FUNCTIONS =====

    /** Show authentication screen */
    async function showAuth() {
      authScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
      currentUser = null;
      selectedLoginUser = null;
      loginHouseholdAccessToken = null;
      loginHouseholdContext = null;
      cachedHousehold = null;
      authToken = null;
      cachedUsers = [];
      localStorage.removeItem('pt_token');
      localStorage.removeItem('pt_user');
      resetCreateFlow();
      resetLoginFlow();
      authCreate.classList.add('hidden');
      authSelect.classList.remove('hidden');
      document.getElementById('login-household-id').value = '';
      document.getElementById('login-household-code').value = '';
      document.getElementById('login-household-id').focus();
    }

    function resetLoginFlow() {
      selectedLoginUser = null;
      loginHouseholdAccessToken = null;
      loginHouseholdContext = null;
      cachedUsers = [];

      document.getElementById('login-member-stage').classList.add('hidden');
      document.getElementById('login-household-stage').classList.remove('hidden');
      document.getElementById('pin-login').classList.add('hidden');
      document.getElementById('login-pin').value = '';
      document.getElementById('login-household-summary').textContent = 'Select your profile';
      document.getElementById('user-list').innerHTML = '';

      hideError('login-household-error');
      hideError('login-error');
    }

    function renderLoginHouseholdSummary() {
      var summary = document.getElementById('login-household-summary');
      if (!summary) {
        return;
      }

      if (!loginHouseholdContext) {
        summary.textContent = 'Select your profile';
        return;
      }

      var displayName = loginHouseholdContext.name || 'Household';
      var displayId = loginHouseholdContext.loginId || loginHouseholdContext.login_id || '';
      summary.textContent = 'Household: ' + displayName + (displayId ? ' (' + displayId + ')' : '');
    }

    async function resolveHouseholdForLogin() {
      var householdLoginId = document.getElementById('login-household-id').value.trim().toUpperCase();
      var householdCode = document.getElementById('login-household-code').value.trim();

      hideError('login-household-error');
      hideError('login-error');

      if (!householdLoginId) {
        showError('login-household-error', 'Household ID is required');
        return;
      }

      if (!/^\d{6}$/.test(householdCode)) {
        showError('login-household-error', 'Household code must be 6 digits');
        return;
      }

      try {
        var result = await api('POST', '/auth/household/access', {
          householdLoginId: householdLoginId,
          householdCode: householdCode
        });

        loginHouseholdAccessToken = result.accessToken;
        loginHouseholdContext = result.household || null;
        cachedUsers = Array.isArray(result.members) ? result.members : [];
        selectedLoginUser = null;

        renderUserList();
        renderLoginHouseholdSummary();

        document.getElementById('login-household-stage').classList.add('hidden');
        document.getElementById('login-member-stage').classList.remove('hidden');
        document.getElementById('pin-login').classList.add('hidden');
        document.getElementById('login-pin').value = '';
      } catch (e) {
        showError('login-household-error', e.message || 'Unable to verify household login details');
      }
    }

    function changeLoginHousehold() {
      selectedLoginUser = null;
      loginHouseholdAccessToken = null;
      loginHouseholdContext = null;
      cachedUsers = [];

      document.getElementById('user-list').innerHTML = '';
      document.getElementById('pin-login').classList.add('hidden');
      document.getElementById('login-pin').value = '';
      document.getElementById('login-member-stage').classList.add('hidden');
      document.getElementById('login-household-stage').classList.remove('hidden');
      document.getElementById('login-household-code').focus();

      hideError('login-household-error');
      hideError('login-error');
    }

    /** Render the user list on auth screen */
    function renderUserList() {
      var users = cachedUsers;
      var list = document.getElementById('user-list');
      list.innerHTML = '';

      if (users.length === 0) {
        list.innerHTML = '<li style="cursor:default; font-size:12px; text-transform:uppercase; letter-spacing:1px;">No users found for this household.</li>';
        return;
      }

      users.forEach(function(u) {
        var li = document.createElement('li');
        li.textContent = u.name;
        li.setAttribute('data-id', u.id);
        li.addEventListener('click', function() {
          selectLoginUser(u);
        });
        list.appendChild(li);
      });
    }

    /** Select a user to log in */
    function selectLoginUser(user) {
      selectedLoginUser = user;
      var items = document.querySelectorAll('#user-list li');
      items.forEach(function(li) {
        li.classList.toggle('selected', li.getAttribute('data-id') === user.id);
      });
      document.getElementById('pin-login').classList.remove('hidden');
      document.getElementById('login-pin').value = '';
      document.getElementById('login-pin').focus();
      hideError('login-error');
    }

    /** Attempt login with PIN — calls server */
    async function attemptLogin() {
      var pin = document.getElementById('login-pin').value.trim();
      if (!selectedLoginUser) {
        showError('login-error', 'Select a user first');
        return;
      }
      if (!loginHouseholdAccessToken) {
        showError('login-household-error', 'Enter household details first');
        return;
      }
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        showError('login-error', 'PIN must be 4 digits');
        return;
      }

      try {
        var result = await api('POST', '/auth/login', {
          userId: selectedLoginUser.id,
          pin: pin,
          householdAccessToken: loginHouseholdAccessToken
        });
        authToken = result.token;
        currentUser = result.user;
        localStorage.setItem('pt_token', result.token);
        localStorage.setItem('pt_user', JSON.stringify(result.user));
        enterApp();
      } catch (e) {
        if ((e.message || '').toLowerCase().indexOf('household access expired') !== -1) {
          showError('login-household-error', 'Household access expired. Enter household details again.');
          changeLoginHousehold();
          return;
        }
        showError('login-error', e.message || 'Incorrect PIN');
      }
    }

    /** Enter the app after successful auth */
    async function enterApp() {
      authScreen.classList.add('hidden');
      appScreen.classList.remove('hidden');
      document.getElementById('header-user-name').textContent = currentUser.name;
      var roleLabel = document.getElementById('header-role-label');
      if (roleLabel) {
        roleLabel.textContent = currentUser.role === 'admin' ? 'ADMIN' : 'MEMBER';
      }
      switchTab('dashboard');
    }

    function resetCreateFlow() {
      onboardingState.step = 1;
      onboardingState.path = null;
      onboardingState.joinPreview = null;

      document.getElementById('new-name').value = '';
      document.getElementById('new-pin').value = '';
      document.getElementById('confirm-pin').value = '';
      document.getElementById('invite-code').value = '';
      document.getElementById('household-name').value = '';

      hideError('name-error');
      hideError('pin-error');
      hideError('confirm-error');
      hideError('invite-error');
      hideError('create-confirmation');

      document.getElementById('join-member-list').innerHTML = '';
      document.getElementById('join-confirmation-copy').textContent = '';
      document.getElementById('join-confirmation').classList.add('hidden');

      setGatePath(null);
      renderCreateStep();
    }

    function setGatePath(pathValue) {
      onboardingState.path = pathValue;

      var startCard = document.getElementById('gate-start-household');
      var joinCard = document.getElementById('gate-join-household');
      startCard.classList.toggle('selected', pathValue === 'new');
      joinCard.classList.toggle('selected', pathValue === 'join');

      document.getElementById('btn-gate-next').disabled = !pathValue;
    }

    function renderCreateStep() {
      document.getElementById('create-step-identity').classList.toggle('hidden', onboardingState.step !== 1);
      document.getElementById('create-step-gate').classList.toggle('hidden', onboardingState.step !== 2);
      document.getElementById('create-step-path').classList.toggle('hidden', onboardingState.step !== 3);

      document.querySelectorAll('#onboarding-pips .pip').forEach(function(pip) {
        var step = Number(pip.getAttribute('data-step'));
        pip.classList.toggle('active', step === onboardingState.step);
      });

      var showNewHouseholdPath = onboardingState.path === 'new';
      var showJoinPath = onboardingState.path === 'join';

      document.getElementById('path-new-household').classList.toggle('hidden', !showNewHouseholdPath);
      document.getElementById('path-join-household').classList.toggle('hidden', !showJoinPath);

      if (showNewHouseholdPath && !document.getElementById('household-name').value.trim()) {
        var typedName = document.getElementById('new-name').value.trim();
        if (typedName) {
          document.getElementById('household-name').value = typedName + "'s Household";
        }
      }

      if (showJoinPath) {
        var confirmation = document.getElementById('join-confirmation');
        if (!onboardingState.joinPreview) {
          confirmation.classList.add('hidden');
        } else {
          confirmation.classList.remove('hidden');
          var memberList = document.getElementById('join-member-list');
          memberList.innerHTML = '';

          onboardingState.joinPreview.members.forEach(function(member) {
            var item = document.createElement('li');
            item.style.cursor = 'default';
            var publicRole = member.role === 'admin' ? 'Admin' : 'Member';
            item.textContent = member.name + ' (' + publicRole + ')';
            memberList.appendChild(item);
          });

          var memberCount = onboardingState.joinPreview.members.length;
          var householdName = onboardingState.joinPreview.householdName || 'this household';
          var memberCopy = memberCount === 1
            ? '1 existing member'
            : memberCount + ' existing members';
          var expiryCopy = onboardingState.joinPreview.expiresAt
            ? ' Invite expires ' + formatTime(onboardingState.joinPreview.expiresAt) + '.'
            : '';

          document.getElementById('join-confirmation-copy').textContent =
            'You are joining ' + householdName + ' with ' + memberCopy + '.' + expiryCopy;
        }
      }
    }

    function validateIdentityStep() {
      var name = document.getElementById('new-name').value.trim();
      var pin = document.getElementById('new-pin').value.trim();
      var confirmPin = document.getElementById('confirm-pin').value.trim();
      var valid = true;

      hideError('name-error');
      hideError('pin-error');
      hideError('confirm-error');

      if (!name || name.length < 1) {
        showError('name-error', 'Name is required');
        valid = false;
      }

      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        showError('pin-error', 'PIN must be 4 digits');
        valid = false;
      }

      if (pin !== confirmPin) {
        showError('confirm-error', 'PINs do not match');
        valid = false;
      }

      if (!valid) {
        return null;
      }

      return { name: name, pin: pin };
    }

    function nextCreateStepFromIdentity() {
      var identity = validateIdentityStep();
      if (!identity) {
        return;
      }

      onboardingState.step = 2;
      renderCreateStep();
    }

    function nextCreateStepFromGate() {
      if (!onboardingState.path) {
        return;
      }

      onboardingState.step = 3;
      renderCreateStep();
    }

    async function verifyInviteCode() {
      var inviteCode = document.getElementById('invite-code').value.trim();
      hideError('invite-error');

      if (!inviteCode) {
        showError('invite-error', 'Invite code is required');
        onboardingState.joinPreview = null;
        renderCreateStep();
        return;
      }

      try {
        var preview = await api('GET', '/auth/invites/' + encodeURIComponent(inviteCode));
        var members = Array.isArray(preview?.members) ? preview.members : [];

        if (members.length === 0) {
          onboardingState.joinPreview = null;
          showError('invite-error', 'Invite code is invalid');
          renderCreateStep();
          return;
        }

        onboardingState.joinPreview = {
          code: inviteCode,
          members: members,
          expiresAt: preview.expires_at,
          householdName: preview.household?.name || null
        };
        renderCreateStep();
      } catch (e) {
        onboardingState.joinPreview = null;
        showError('invite-error', e.message || 'Invite code is invalid or expired');
        renderCreateStep();
      }
    }

    /** Create a new user from onboarding flow — calls server */
    async function completeOnboarding(pathKind) {
      var identity = validateIdentityStep();
      if (!identity) {
        onboardingState.step = 1;
        renderCreateStep();
        return;
      }

      hideError('create-confirmation');

      try {
        var payload = {
          name: identity.name,
          pin: identity.pin
        };

        if (pathKind === 'new') {
          var householdName = document.getElementById('household-name').value.trim();
          payload.createHousehold = true;
          payload.householdName = householdName || (identity.name + "'s Household");
        }

        if (pathKind === 'join') {
          var inviteCode = onboardingState.joinPreview?.code || document.getElementById('invite-code').value.trim();
          if (!inviteCode) {
            showError('invite-error', 'Invite code is required');
            return;
          }
          payload.inviteCode = inviteCode;
        }

        var result = await api('POST', '/auth/register', {
          name: payload.name,
          pin: payload.pin,
          inviteCode: payload.inviteCode || undefined,
          createHousehold: payload.createHousehold,
          householdName: payload.householdName
        });

        // Auto-login after registration
        authToken = result.token;
        currentUser = result.user;
        localStorage.setItem('pt_token', result.token);
        localStorage.setItem('pt_user', JSON.stringify(result.user));

        if (pathKind === 'new' && result.user && result.user.role === 'admin') {
          var householdLoginId = result.householdAuth?.householdLoginId;
          var householdCode = result.householdAuth?.householdCode;

          if (householdLoginId && householdCode) {
            alert(
              'Household created. You are the admin for this household.\n\n' +
              'Household ID: ' + householdLoginId + '\n' +
              'Household Code: ' + householdCode + '\n\n' +
              'Share these login details with your household members.'
            );
          } else {
            alert('Household created. You are the admin for this household.');
          }
        }

        // Clear form and go back to login view
        resetCreateFlow();
        authCreate.classList.add('hidden');
        authSelect.classList.remove('hidden');

        // Enter app directly
        enterApp();
      } catch (e) {
        if (pathKind === 'join') {
          showError('invite-error', e.message || 'Failed to join household');
        } else {
          showError('create-confirmation', e.message || 'Failed to create profile');
        }
      }
    }

    // ===== ERROR HELPERS =====
    function showError(id, msg) {
      var el = document.getElementById(id);
      el.textContent = msg;
      el.classList.remove('hidden');
    }

    function hideError(id) {
      var el = document.getElementById(id);
      el.textContent = '';
      el.classList.add('hidden');
    }

    // ===== TAB NAVIGATION =====
    function switchTab(tabName) {
      document.querySelectorAll('#nav-tabs button').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
      });
      document.querySelectorAll('.tab-content').forEach(function(tc) {
        tc.classList.toggle('active', tc.id === 'tab-' + tabName);
      });
      refreshApp();
    }

    // ===== SUB-TAB NAVIGATION (Requests) =====
    function switchSubTab(subTabName) {
      document.querySelectorAll('.sub-tabs button').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-subtab') === subTabName);
      });
      document.getElementById('subtab-incoming').classList.toggle('hidden', subTabName !== 'incoming');
      document.getElementById('subtab-outgoing').classList.toggle('hidden', subTabName !== 'outgoing');
      document.getElementById('subtab-resolved').classList.toggle('hidden', subTabName !== 'resolved');
      document.getElementById('subtab-new-request').classList.toggle('hidden', subTabName !== 'new-request');
    }

    // ===== REFRESH ALL APP DATA =====
    async function refreshApp() {
      if (!currentUser) return;
      await Promise.all([loadUsers(), loadRequests(), loadPayments(), loadHousehold()]);
      refreshDashboard();
      refreshRequests();
      refreshPayTab();
      refreshHistory();
      refreshSettings();
      populateUserDropdowns();
    }

    // ===== POPULATE USER DROPDOWNS =====
    function populateUserDropdowns() {
      var users = cachedUsers.filter(function(u) { return u.id !== currentUser.id; });
      var dropdowns = [document.getElementById('req-user'), document.getElementById('pay-user')];

      dropdowns.forEach(function(sel) {
        var currentVal = sel.value;
        sel.innerHTML = '<option value="">-- Select User --</option>';
        users.forEach(function(u) {
          var opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.name;
          sel.appendChild(opt);
        });
        if (currentVal) sel.value = currentVal;
      });
    }

    // ===== DASHBOARD =====
    function refreshDashboard() {
      var requests = cachedRequests;
      var payments = cachedPayments;
      var uid = currentUser.id;

      var owedToMe = 0;
      var iOwe = 0;

      requests.forEach(function(r) {
        if (r.status !== 'accepted') return;
        if (r.from_id === uid) owedToMe += Number(r.amount);
        if (r.to_id === uid) iOwe += Number(r.amount);
      });

      payments.forEach(function(p) {
        if (p.status !== 'confirmed') return;
        if (p.from_id === uid) iOwe -= Number(p.amount);
        if (p.to_id === uid) owedToMe -= Number(p.amount);
      });

      owedToMe = Math.max(0, owedToMe);
      iOwe = Math.max(0, iOwe);

      document.getElementById('metric-owed-to-me').textContent = formatAmount(owedToMe);
      document.getElementById('metric-i-owe').textContent = formatAmount(iOwe);

      var pendingCount = requests.filter(function(r) {
        return r.to_id === uid && r.status === 'pending';
      }).length;
      pendingCount += payments.filter(function(p) {
        return p.to_id === uid && p.status === 'sent';
      }).length;
      document.getElementById('metric-pending').textContent = pendingCount;

      var allActivity = getActivityForUser(uid);
      var latestEl = document.getElementById('metric-latest');
      if (allActivity.length > 0) {
        latestEl.textContent = allActivity[0].text;
      } else {
        latestEl.textContent = 'No activity yet';
      }

      var hasAnyTransactions = requests.length > 0 || payments.length > 0;
      var emptyState = document.getElementById('dashboard-empty-state');
      var emptyCopy = document.getElementById('dashboard-empty-copy');
      var emptyAction = document.getElementById('btn-dashboard-empty-action');
      if (!emptyState || !emptyCopy || !emptyAction) {
        return;
      }

      if (hasAnyTransactions) {
        emptyState.classList.add('hidden');
        return;
      }

      var memberCount = Number(cachedHousehold?.memberCount || 0);
      var shouldPromptInvite = currentUser.role === 'admin' && memberCount <= 1;

      if (shouldPromptInvite) {
        emptyCopy.textContent = 'No requests yet. Add someone to your household to get started.';
        emptyAction.textContent = 'Generate Invite Code';
        emptyAction.setAttribute('data-action', 'invite');
      } else {
        emptyCopy.textContent = 'No requests yet. Send your first request.';
        emptyAction.textContent = 'Send Your First Request';
        emptyAction.setAttribute('data-action', 'request');
      }

      emptyState.classList.remove('hidden');
    }

    async function handleDashboardEmptyAction() {
      var button = document.getElementById('btn-dashboard-empty-action');
      var action = button?.getAttribute('data-action');

      if (action === 'invite') {
        switchTab('settings');
        await generateHouseholdInvite();
        return;
      }

      switchTab('requests');
      switchSubTab('new-request');
      document.getElementById('req-user').focus();
    }

    // ===== REQUESTS TAB =====
    function refreshRequests() {
      var requests = cachedRequests;
      var uid = currentUser.id;

      var incoming = requests.filter(function(r) {
        return r.to_id === uid && !isResolvedRequest(r);
      })
        .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

      var incomingList = document.getElementById('incoming-list');
      incomingList.innerHTML = '';

      if (incoming.length === 0) {
        incomingList.innerHTML = '<div class="empty-state">No incoming requests</div>';
      } else {
        incoming.forEach(function(r) {
          incomingList.appendChild(createRequestRow(r, 'incoming'));
        });
      }

      var outgoing = requests.filter(function(r) {
        return r.from_id === uid && !isResolvedRequest(r);
      })
        .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

      var outgoingList = document.getElementById('outgoing-list');
      outgoingList.innerHTML = '';

      if (outgoing.length === 0) {
        outgoingList.innerHTML = '<div class="empty-state">No outgoing requests</div>';
      } else {
        outgoing.forEach(function(r) {
          outgoingList.appendChild(createRequestRow(r, 'outgoing'));
        });
      }

      var resolved = requests.filter(function(r) {
        return (r.from_id === uid || r.to_id === uid) && isResolvedRequest(r);
      }).sort(function(a, b) {
        var aTime = a.resolved_at || a.created_at;
        var bTime = b.resolved_at || b.created_at;
        return new Date(bTime) - new Date(aTime);
      });

      var resolvedList = document.getElementById('resolved-list');
      resolvedList.innerHTML = '';

      if (resolved.length === 0) {
        resolvedList.innerHTML = '<div class="empty-state">No resolved requests</div>';
      } else {
        resolved.forEach(function(r) {
          resolvedList.appendChild(createRequestRow(r, 'resolved'));
        });
      }
    }

    /** Create a request row element */
    function createRequestRow(req, direction) {
      var li = document.createElement('li');
      li.className = 'item-row';

      var fromName = getUserName(req.from_id);
      var toName = getUserName(req.to_id);
      var reason = req.reason ? ' for ' + req.reason : '';
      var uid = currentUser.id;

      var descText = direction === 'incoming'
        ? fromName + ' requests ' + formatAmount(req.amount) + ' from you' + reason
        : direction === 'outgoing'
          ? 'You requested ' + formatAmount(req.amount) + ' from ' + toName + reason
          : (req.status === 'settled'
            ? 'Resolved with ' + (req.from_id === uid ? toName : fromName) + ': ' + formatAmount(req.amount) + reason
            : 'Request with ' + (req.from_id === uid ? toName : fromName) + ' was rejected' + reason);

      li.innerHTML =
        '<div class="item-header">' +
          '<span class="item-desc">' + escapeHtml(descText) + '</span>' +
          '<span class="badge">' + req.status.toUpperCase() + '</span>' +
        '</div>' +
        '<div class="item-meta">' + formatTime(req.created_at) + '</div>' +
        '<div class="item-actions" id="actions-' + req.id + '"></div>' +
        '<div id="chat-area-' + req.id + '"></div>';

      var actionsDiv = li.querySelector('#actions-' + req.id);

      if (direction === 'incoming' && req.status === 'pending') {
        var acceptBtn = document.createElement('button');
        acceptBtn.className = 'btn-sm btn-navy';
        acceptBtn.textContent = 'Accept';
        acceptBtn.addEventListener('click', function() { handleRequest(req.id, 'accepted'); });

        var rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn-sm';
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', function() { handleRequest(req.id, 'rejected'); });

        actionsDiv.appendChild(acceptBtn);
        actionsDiv.appendChild(rejectBtn);
      }

      var chatToggle = document.createElement('button');
      chatToggle.className = 'chat-toggle';
      chatToggle.textContent = '[ Messages ]';
      chatToggle.addEventListener('click', function() {
        toggleChat(req.id, 'request', li.querySelector('#chat-area-' + req.id));
      });
      actionsDiv.appendChild(chatToggle);

      return li;
    }

    function getLinkableRequestsForPayment() {
      var uid = currentUser.id;
      return cachedRequests.filter(function(req) {
        return req.to_id === uid &&
          (req.status === 'accepted' || req.status === 'partially_settled') &&
          Number(req.remaining) > 0;
      }).sort(function(a, b) {
        return new Date(b.created_at) - new Date(a.created_at);
      });
    }

    function applyLinkedRequestSelection() {
      var linkedSelect = document.getElementById('pay-linked-request');
      var recipientSelect = document.getElementById('pay-user');
      var amountInput = document.getElementById('pay-amount');
      var hint = document.getElementById('pay-linked-request-hint');

      if (!linkedSelect || !recipientSelect || !amountInput || !hint) {
        return;
      }

      var selectedOption = linkedSelect.options[linkedSelect.selectedIndex];
      if (!linkedSelect.value) {
        recipientSelect.disabled = false;
        hint.textContent = 'Optional: tie this payment to an accepted request.';
        return;
      }

      var recipientId = selectedOption.getAttribute('data-recipient-id');
      var remaining = Number(selectedOption.getAttribute('data-remaining'));

      if (recipientId) {
        recipientSelect.value = recipientId;
      }
      recipientSelect.disabled = true;

      if (!amountInput.value && Number.isFinite(remaining) && remaining > 0) {
        amountInput.value = remaining.toFixed(2);
      }

      hint.textContent = Number.isFinite(remaining) && remaining > 0
        ? 'Linked request selected. Recipient is locked to the requester. Remaining: ' + formatAmount(remaining)
        : 'Linked request selected. Recipient is locked to the requester.';
    }

    function refreshLinkedRequestOptions() {
      var linkedSelect = document.getElementById('pay-linked-request');
      if (!linkedSelect || !currentUser) {
        return;
      }

      var previousValue = linkedSelect.value;
      var linkableRequests = getLinkableRequestsForPayment();
      linkedSelect.innerHTML = '<option value="">-- No linked request --</option>';

      linkableRequests.forEach(function(req) {
        var option = document.createElement('option');
        var requesterName = getUserName(req.from_id);
        var reasonText = req.reason ? ' - ' + req.reason : '';
        option.value = req.id;
        option.setAttribute('data-recipient-id', req.from_id);
        option.setAttribute('data-remaining', String(req.remaining));
        option.textContent = requesterName + ' | ' + formatAmount(req.remaining) + ' remaining' + reasonText;
        linkedSelect.appendChild(option);
      });

      if (previousValue) {
        var hasPrevious = linkableRequests.some(function(req) { return req.id === previousValue; });
        if (hasPrevious) {
          linkedSelect.value = previousValue;
        }
      }

      applyLinkedRequestSelection();
    }

    /** Handle accepting or rejecting a request — calls server */
    async function handleRequest(reqId, newStatus) {
      try {
        await api('PATCH', '/requests/' + reqId, { status: newStatus });
        await refreshApp();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    /** Send a new money request — calls server */
    async function sendRequest() {
      var toId = document.getElementById('req-user').value;
      var amount = document.getElementById('req-amount').value;
      var reason = document.getElementById('req-reason').value.trim();
      var valid = true;

      hideError('req-amount-error');
      hideError('req-error');

      if (!toId) {
        showError('req-error', 'Select a user to request from');
        valid = false;
      }

      var amountNum = parseFloat(amount);
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        showError('req-amount-error', 'Amount must be greater than 0');
        valid = false;
      }

      if (!valid) return;

      try {
        await api('POST', '/requests', { toId: toId, amount: amountNum, reason: reason });

        document.getElementById('req-user').value = '';
        document.getElementById('req-amount').value = '';
        document.getElementById('req-reason').value = '';

        switchSubTab('outgoing');
        await refreshApp();
      } catch (e) {
        showError('req-error', e.message || 'Failed to send request');
      }
    }

    // ===== PAY TAB =====
    function refreshPayTab() {
      refreshLinkedRequestOptions();

      var payments = cachedPayments;
      var uid = currentUser.id;

      var pending = payments.filter(function(p) {
        return p.to_id === uid && p.status === 'sent';
      }).sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });

      var section = document.getElementById('pending-payments-section');
      var list = document.getElementById('pending-payments-list');
      list.innerHTML = '';

      if (pending.length > 0) {
        section.classList.remove('hidden');
        pending.forEach(function(p) {
          list.appendChild(createPaymentRow(p));
        });
      } else {
        section.classList.add('hidden');
      }
    }

    /** Create a payment row with confirm/dispute actions */
    function createPaymentRow(payment) {
      var li = document.createElement('li');
      li.className = 'item-row';

      var fromName = getUserName(payment.from_id);
      var msg = payment.message ? ' — "' + payment.message + '"' : '';

      li.innerHTML =
        '<div class="item-header">' +
          '<span class="item-desc">' + escapeHtml(fromName) + ' sent you ' + formatAmount(payment.amount) + escapeHtml(msg) + '</span>' +
          '<span class="badge">' + payment.status.toUpperCase() + '</span>' +
        '</div>' +
        '<div class="item-meta">' + formatTime(payment.created_at) + '</div>' +
        '<div class="item-actions" id="pay-actions-' + payment.id + '"></div>' +
        '<div id="chat-area-pay-' + payment.id + '"></div>';

      var actionsDiv = li.querySelector('#pay-actions-' + payment.id);

      if (payment.status === 'sent') {
        var confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn-sm btn-navy';
        confirmBtn.textContent = 'Confirm';
        confirmBtn.addEventListener('click', function() { handlePayment(payment.id, 'confirmed'); });

        var disputeBtn = document.createElement('button');
        disputeBtn.className = 'btn-sm';
        disputeBtn.textContent = 'Dispute';
        disputeBtn.addEventListener('click', function() { handlePayment(payment.id, 'disputed'); });

        actionsDiv.appendChild(confirmBtn);
        actionsDiv.appendChild(disputeBtn);
      }

      var chatToggle = document.createElement('button');
      chatToggle.className = 'chat-toggle';
      chatToggle.textContent = '[ Messages ]';
      chatToggle.addEventListener('click', function() {
        toggleChat(payment.id, 'payment', li.querySelector('#chat-area-pay-' + payment.id));
      });
      actionsDiv.appendChild(chatToggle);

      return li;
    }

    /** Handle confirming or disputing a payment — calls server */
    async function handlePayment(payId, newStatus) {
      try {
        await api('PATCH', '/payments/' + payId, { status: newStatus });
        await refreshApp();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    /** Send a new payment — calls server */
    async function sendPayment() {
      var linkedRequestId = document.getElementById('pay-linked-request').value;
      var toId = document.getElementById('pay-user').value;
      var amount = document.getElementById('pay-amount').value;
      var category = document.getElementById('pay-category').value.trim();
      var message = document.getElementById('pay-message').value.trim();
      var valid = true;

      hideError('pay-amount-error');
      hideError('pay-error');

      if (!linkedRequestId && !toId) {
        showError('pay-error', 'Select a recipient');
        valid = false;
      }

      var amountNum = parseFloat(amount);
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        showError('pay-amount-error', 'Amount must be greater than 0');
        valid = false;
      }

      if (!valid) return;

      try {
        var payload = {
          amount: amountNum,
          message: message,
          category: category || undefined,
          toId: toId || undefined,
          requestId: linkedRequestId || undefined
        };

        await api('POST', '/payments', payload);

        document.getElementById('pay-linked-request').value = '';
        document.getElementById('pay-user').value = '';
        document.getElementById('pay-amount').value = '';
        document.getElementById('pay-category').value = '';
        document.getElementById('pay-message').value = '';
        applyLinkedRequestSelection();

        await refreshApp();
      } catch (e) {
        showError('pay-error', e.message || 'Failed to send payment');
      }
    }

    // ===== CHAT / MESSAGES =====

    /** Toggle chat panel for a request or payment */
    function toggleChat(refId, refType, container) {
      if (container.querySelector('.chat-box')) {
        container.innerHTML = '';
        return;
      }
      renderChat(refId, refType, container);
    }

    /** Render chat messages for a request or payment — fetches from server */
    async function renderChat(refId, refType, container) {
      var messages = [];
      try {
        messages = await api('GET', '/messages?refType=' + refType + '&refId=' + refId);
      } catch (e) {
        messages = [];
      }

      var chatHtml =
        '<div class="chat-box">' +
          '<div class="chat-messages" id="chat-msgs-' + refId + '">';

      if (messages.length === 0) {
        chatHtml += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;">No messages yet</div>';
      } else {
        messages.forEach(function(m) {
          chatHtml +=
            '<div class="chat-msg">' +
              '<span class="chat-author">' + escapeHtml(getUserName(m.user_id)) + '</span> ' +
              '<span class="chat-time">' + formatTime(m.timestamp) + '</span>' +
              '<div>' + escapeHtml(m.text) + '</div>' +
            '</div>';
        });
      }

      chatHtml +=
          '</div>' +
          '<div class="chat-input-row">' +
            '<input type="text" id="chat-input-' + refId + '" placeholder="Type a message..." maxlength="200">' +
            '<button id="chat-send-' + refId + '">Send</button>' +
          '</div>' +
        '</div>';

      container.innerHTML = chatHtml;

      var msgsDiv = container.querySelector('#chat-msgs-' + refId);
      msgsDiv.scrollTop = msgsDiv.scrollHeight;

      var sendBtn = container.querySelector('#chat-send-' + refId);
      var input = container.querySelector('#chat-input-' + refId);

      sendBtn.addEventListener('click', function() {
        sendChatMessage(refId, refType, input, container);
      });

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          sendChatMessage(refId, refType, input, container);
        }
      });
    }

    /** Send a chat message — calls server */
    async function sendChatMessage(refId, refType, inputEl, container) {
      var text = inputEl.value.trim();
      if (!text) return;

      try {
        await api('POST', '/messages', { refType: refType, refId: refId, text: text });
        await renderChat(refId, refType, container);
      } catch (e) {
        alert('Error sending message: ' + e.message);
      }
    }

    // ===== HISTORY TAB =====
    function refreshHistory() {
      var uid = currentUser.id;
      var allActivity = getActivityForUser(uid);

      var historyList = document.getElementById('history-list');
      historyList.innerHTML = '';

      if (allActivity.length === 0) {
        historyList.innerHTML = '<div class="empty-state">No transaction history</div>';
        return;
      }

      allActivity.forEach(function(act) {
        var li = document.createElement('li');
        li.className = 'activity-item';
        li.innerHTML =
          '<span class="activity-text">' + escapeHtml(act.text) + '</span>' +
          '<span class="badge">' + act.status.toUpperCase() + '</span>' +
          '<span class="activity-time">' + formatTime(act.timestamp) + '</span>';
        historyList.appendChild(li);
      });
    }

    /** Get all activity (requests + payments) for a user, sorted by time desc */
    function getActivityForUser(uid) {
      var requests = cachedRequests;
      var payments = cachedPayments;
      var activity = [];

      requests.forEach(function(r) {
        if (r.from_id !== uid && r.to_id !== uid) return;
        var fromName = getUserName(r.from_id);
        var toName = getUserName(r.to_id);
        var reason = r.reason ? ' for ' + r.reason : '';
        activity.push({
          text: fromName + ' \u2192 ' + toName + ' ' + formatAmount(r.amount) + ' request' + reason,
          status: r.status,
          timestamp: r.resolved_at || r.created_at
        });
      });

      payments.forEach(function(p) {
        if (p.from_id !== uid && p.to_id !== uid) return;
        var fromName = getUserName(p.from_id);
        var toName = getUserName(p.to_id);
        activity.push({
          text: fromName + ' \u2192 ' + toName + ' ' + formatAmount(p.amount) + ' payment',
          status: p.status,
          timestamp: p.resolved_at || p.created_at
        });
      });

      activity.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
      return activity;
    }

    // ===== SETTINGS =====
    function refreshSettings() {
      var users = cachedUsers;
      var list = document.getElementById('settings-user-list');
      list.innerHTML = '';
      users.forEach(function(u) {
        var li = document.createElement('li');
        li.style.cursor = 'default';
        li.textContent = u.name + (u.id === currentUser.id ? ' (you)' : '');
        list.appendChild(li);
      });

      var householdLoginIdInput = document.getElementById('settings-household-login-id');
      if (householdLoginIdInput) {
        householdLoginIdInput.value = cachedHousehold?.loginId || cachedHousehold?.login_id || '';
      }
    }

    /** Change the current user's PIN — calls server */
    async function changePin() {
      var oldPin = document.getElementById('settings-old-pin').value.trim();
      var newPin = document.getElementById('settings-new-pin').value.trim();

      hideError('settings-pin-error');

      if (!oldPin || oldPin.length !== 4 || !/^\d{4}$/.test(oldPin)) {
        showError('settings-pin-error', 'Current PIN must be 4 digits');
        return;
      }

      if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
        showError('settings-pin-error', 'New PIN must be 4 digits');
        return;
      }

      try {
        var result = await api('PATCH', '/users/pin', { oldPin: oldPin, newPin: newPin });
        document.getElementById('settings-old-pin').value = '';
        document.getElementById('settings-new-pin').value = '';

        if (result && result.sessionRevoked) {
          localStorage.removeItem('pt_token');
          localStorage.removeItem('pt_user');
          authToken = null;
          currentUser = null;
          alert('PIN updated. Please sign in again.');
          showAuth();
          return;
        }

        showError('settings-pin-error', 'PIN updated successfully');
      } catch (e) {
        showError('settings-pin-error', e.message || 'Failed to update PIN');
      }
    }

    async function copyTextToClipboard(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      var tempInput = document.createElement('input');
      tempInput.value = value;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
    }

    /** Generate a household invite code — calls server */
    async function generateHouseholdInvite() {
      var ttlRaw = document.getElementById('settings-invite-ttl').value;
      var ttlHours = Number.parseInt(ttlRaw, 10);

      hideError('settings-invite-error');

      if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
        showError('settings-invite-error', 'Invite expiry must be between 1 and 168 hours');
        return;
      }

      try {
        var invite = await api('POST', '/auth/household/invites', { ttlHours: ttlHours });
        document.getElementById('settings-invite-code').value = invite.code;
        document.getElementById('settings-invite-meta').textContent = 'Expires ' + formatTime(invite.expires_at);

        try {
          await copyTextToClipboard(invite.code);
          showError('settings-invite-error', 'Invite code generated and copied');
        } catch (copyErr) {
          showError('settings-invite-error', 'Invite code generated. Copy it manually below');
        }
      } catch (e) {
        showError('settings-invite-error', e.message || 'Failed to generate invite code');
      }
    }

    async function copyHouseholdInviteCode() {
      var code = document.getElementById('settings-invite-code').value.trim();
      hideError('settings-invite-error');

      if (!code) {
        showError('settings-invite-error', 'Generate an invite code first');
        return;
      }

      try {
        await copyTextToClipboard(code);
        showError('settings-invite-error', 'Invite code copied');
      } catch (e) {
        showError('settings-invite-error', 'Unable to copy automatically. Copy the code manually');
      }
    }

    async function rotateHouseholdLoginCode() {
      hideError('settings-household-login-error');

      try {
        var rotated = await api('POST', '/auth/household/login-code/rotate', {});
        document.getElementById('settings-household-login-id').value = rotated.householdLoginId || '';
        document.getElementById('settings-household-login-code').value = rotated.householdCode || '';

        try {
          await copyTextToClipboard(rotated.householdCode || '');
          showError('settings-household-login-error', 'Household code rotated and copied');
        } catch (copyErr) {
          showError('settings-household-login-error', 'Household code rotated. Copy it from the field below');
        }
      } catch (e) {
        showError('settings-household-login-error', e.message || 'Failed to rotate household code');
      }
    }

    /** Reset all server data (requires backend ALLOW_DATA_RESET=true) */
    async function resetAllData() {
      var approved = confirm('This will delete ALL server data for every user. Continue?');
      if (!approved) return;

      var phrase = prompt('Type RESET EVERYTHING to confirm:');
      if (phrase !== 'RESET EVERYTHING') {
        alert('Reset cancelled: confirmation text did not match.');
        return;
      }

      try {
        await api('DELETE', '/users/reset-all', { confirmation: phrase });
        alert('All data has been reset. You will be logged out.');
        showAuth();
      } catch (e) {
        alert('Reset failed: ' + e.message);
      }
    }

    // ===== XSS PROTECTION =====
    function escapeHtml(str) {
      if (!str) return '';
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    }

    // ===== EVENT LISTENERS =====
    function setupEventListeners() {
      window.addEventListener('online', function() {
        updateConnectivityFromNavigator();
        if (currentUser) {
          refreshApp();
        }
      });
      window.addEventListener('offline', updateConnectivityFromNavigator);

      document.getElementById('btn-create-user').addEventListener('click', function() {
        resetCreateFlow();
        authSelect.classList.add('hidden');
        authCreate.classList.remove('hidden');
        document.getElementById('new-name').focus();
      });

      document.getElementById('btn-back-login').addEventListener('click', function() {
        resetCreateFlow();
        authCreate.classList.add('hidden');
        authSelect.classList.remove('hidden');
      });

      document.getElementById('btn-login-household').addEventListener('click', resolveHouseholdForLogin);
      document.getElementById('login-household-id').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') resolveHouseholdForLogin();
      });
      document.getElementById('login-household-code').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') resolveHouseholdForLogin();
      });
      document.getElementById('btn-change-household').addEventListener('click', changeLoginHousehold);
      document.getElementById('btn-login').addEventListener('click', attemptLogin);
      document.getElementById('login-pin').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') attemptLogin();
      });

      document.getElementById('btn-identity-next').addEventListener('click', nextCreateStepFromIdentity);
      document.getElementById('btn-gate-back').addEventListener('click', function() {
        onboardingState.step = 1;
        renderCreateStep();
      });
      document.getElementById('btn-gate-next').addEventListener('click', nextCreateStepFromGate);
      document.getElementById('btn-path-back').addEventListener('click', function() {
        onboardingState.joinPreview = null;
        hideError('invite-error');
        onboardingState.step = 2;
        renderCreateStep();
      });
      document.getElementById('gate-start-household').addEventListener('click', function() {
        setGatePath('new');
      });
      document.getElementById('gate-join-household').addEventListener('click', function() {
        setGatePath('join');
      });
      document.getElementById('btn-complete-new').addEventListener('click', function() {
        completeOnboarding('new');
      });
      document.getElementById('btn-verify-invite').addEventListener('click', verifyInviteCode);
      document.getElementById('btn-complete-join').addEventListener('click', function() {
        completeOnboarding('join');
      });
      document.getElementById('confirm-pin').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') nextCreateStepFromIdentity();
      });
      document.getElementById('invite-code').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') verifyInviteCode();
      });

      document.getElementById('btn-logout').addEventListener('click', function() { showAuth(); });

      document.querySelectorAll('#nav-tabs button').forEach(function(btn) {
        btn.addEventListener('click', function() {
          switchTab(btn.getAttribute('data-tab'));
        });
      });

      document.querySelectorAll('.sub-tabs button').forEach(function(btn) {
        btn.addEventListener('click', function() {
          switchSubTab(btn.getAttribute('data-subtab'));
        });
      });

      document.getElementById('btn-send-request').addEventListener('click', sendRequest);
      document.getElementById('pay-linked-request').addEventListener('change', applyLinkedRequestSelection);
      document.getElementById('btn-send-payment').addEventListener('click', sendPayment);
      document.getElementById('btn-change-pin').addEventListener('click', changePin);
      document.getElementById('btn-generate-invite').addEventListener('click', generateHouseholdInvite);
      document.getElementById('btn-copy-invite').addEventListener('click', copyHouseholdInviteCode);
      document.getElementById('btn-rotate-household-code').addEventListener('click', rotateHouseholdLoginCode);
      document.getElementById('btn-reset-data').addEventListener('click', resetAllData);
      document.getElementById('btn-dashboard-empty-action').addEventListener('click', handleDashboardEmptyAction);
    }

    // ===== START =====
    init();
