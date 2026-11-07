/**
 * De’vyora — shared frontend API client.
 *
 * Include this on every page that needs to talk to the backend:
 *
 * <script src="assets/api-client.js"></script>
 *
 * Set this BEFORE the script tag if your backend URL differs:
 *
 * <script>
 *   window.CASA_API_BASE = "http://localhost:5000/api/v1";
 * </script>
 */

(function () {
  'use strict';

  // ============================================================
  // API CONFIGURATION
  // ============================================================

  const API_BASE =
    window.CASA_API_BASE ||
    '/api/v1';

  const ACCESS_TOKEN_KEY = 'casa_access_token';
  const USER_KEY = 'casa_user';

  // Which accounts have enrolled a passkey ON THIS DEVICE, and the tab
  // flag that says the visitor has just signed out. Both are per-device
  // conveniences for the login page; neither is a credential, and losing
  // either costs nothing but a tap.
  const PASSKEY_ACCOUNTS_KEY = 'casa_passkey_accounts';
  const SIGNED_OUT_KEY = 'casa_signed_out';

  // ============================================================
  // SESSION STORAGE
  // ============================================================

  function getAccessToken() {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  function setSession(accessToken, user) {
    if (accessToken) {
      localStorage.setItem(
        ACCESS_TOKEN_KEY,
        accessToken
      );
    }

    if (user !== undefined) {
      localStorage.setItem(
        USER_KEY,
        JSON.stringify(user)
      );
    }
  }

  function clearSession() {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function getCachedUser() {
    try {
      const raw =
        localStorage.getItem(USER_KEY);

      return raw
        ? JSON.parse(raw)
        : null;
    } catch {
      return null;
    }
  }

  // ============================================================
  // IS THE TOKEN WE ALREADY HOLD STILL GOOD?
  //
  // Every page called /auth/refresh before it would render anything,
  // even though the access token and the user were already in
  // localStorage from the page before. On a serverless backend that is
  // a cold start per navigation -- the deployment's own logs show
  // roughly 2.7s between the function waking and "Database connected"
  // -- and the whole site sat behind it.
  //
  // A JWT carries its own expiry, so whether the token is still usable
  // is a question the browser can answer by itself, with no round
  // trip. Only when it cannot is the network involved.
  // ============================================================

  // Refresh this long before the token actually expires, so a request
  // started just under the wire does not land just over it.
  const TOKEN_EARLY_REFRESH_MS = 60 * 1000;

  function tokenExpiryMs(token) {
    try {
      const [, payload] = String(token || '').split('.');
      if (!payload) return 0;

      const json = atob(
        payload.replace(/-/g, '+').replace(/_/g, '/')
      );
      const exp = JSON.parse(json).exp;

      return typeof exp === 'number' ? exp * 1000 : 0;
    } catch {
      // Unreadable means not trusted, which sends us to the network --
      // never to treating it as valid.
      return 0;
    }
  }

  function haveUsableSession() {
    const token = getAccessToken();
    if (!token || !getCachedUser()) return false;

    const expiry = tokenExpiryMs(token);
    return expiry > Date.now() + TOKEN_EARLY_REFRESH_MS;
  }

  function redirectToLogin() {
    clearSession();

    const here =
      encodeURIComponent(
        location.pathname +
        location.search
      );

    if (
      !location.pathname.endsWith(
        'login.html'
      )
    ) {
      location.href =
        `login.html?redirect=${here}`;
    }
  }

  // ============================================================
  // API ERROR
  // ============================================================

  class ApiError extends Error {
    constructor(
      message,
      status,
      errors
    ) {
      super(message);

      this.name = 'ApiError';
      this.status = status;
      this.errors = errors;
    }
  }

  // ============================================================
  // REFRESH TOKEN
  // ============================================================

  let refreshInFlight = null;

  function doRefresh() {
    if (!refreshInFlight) {
      refreshInFlight =
        fetch(
          `${API_BASE}/auth/refresh`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type':
                'application/json',
              Accept:
                'application/json'
            }
          }
        )
          .then(async (res) => {
            const body =
              await res
                .json()
                .catch(() => ({}));

            if (!res.ok) {
              throw new ApiError(
                body.message ||
                  'Session expired',
                res.status,
                body.errors
              );
            }

            if (
              !body.data ||
              !body.data.accessToken
            ) {
              throw new ApiError(
                'Refresh response did not contain an access token.',
                res.status
              );
            }

            setSession(
              body.data.accessToken,
              body.data.user
            );

            return body.data;
          })
          .finally(() => {
            refreshInFlight = null;
          });
    }

    return refreshInFlight;
  }

  // ============================================================
  // CORE FETCH
  // ============================================================

  async function apiFetch(
    path,
    {
      method = 'GET',
      body,
      skipAuth = false,
      _retried = false
    } = {}
  ) {
    const headers = {
      Accept:
        'application/json'
    };

    const token =
      getAccessToken();

    if (
      token &&
      !skipAuth
    ) {
      headers.Authorization =
        `Bearer ${token}`;
    }

    let requestBody;

    if (body !== undefined) {
      headers['Content-Type'] =
        'application/json';

      requestBody =
        JSON.stringify(body);
    }

    const res =
      await fetch(
        `${API_BASE}${path}`,
        {
          method,
          headers,
          credentials: 'include',
          body: requestBody
        }
      );

    // ----------------------------------------------------------
    // ACCESS TOKEN EXPIRED
    // ----------------------------------------------------------

    if (
      res.status === 401 &&
      !skipAuth &&
      !_retried &&
      path !== '/auth/refresh'
    ) {
      try {
        await doRefresh();

        return apiFetch(
          path,
          {
            method,
            body,
            skipAuth,
            _retried: true
          }
        );
      } catch {
        redirectToLogin();

        throw new ApiError(
          'Session expired. Please log in again.',
          401
        );
      }
    }

    const responseBody =
      await res
        .json()
        .catch(() => ({}));

    if (!res.ok) {
      const message =
        responseBody?.message ||
        responseBody?.error?.message ||
        `Request failed (${res.status})`;

      const errors =
        responseBody?.errors ||
        responseBody?.error;

      throw new ApiError(
        message,
        res.status,
        errors
      );
    }

    return responseBody;
  }

  // ============================================================
  // QUERY STRING
  // ============================================================

  function qs(params) {
    if (!params) {
      return '';
    }

    const usp =
      new URLSearchParams();

    Object.entries(params)
      .forEach(([key, value]) => {
        if (
          value !== undefined &&
          value !== null &&
          value !== ''
        ) {
          usp.set(
            key,
            value
          );
        }
      });

    const s =
      usp.toString();

    return s
      ? `?${s}`
      : '';
  }

  // ============================================================
  // AUTH
  // ============================================================

  const auth = {
    async login(
      email,
      password
    ) {
      const body =
        await apiFetch(
          '/auth/login',
          {
            method: 'POST',
            body: {
              email,
              password
            },
            skipAuth: true
          }
        );

      setSession(
        body.data.accessToken,
        body.data.user
      );

      return body.data.user;
    },

    async logout() {
      try {
        await apiFetch(
          '/auth/logout',
          {
            method: 'POST'
          }
        );
      } finally {
        clearSession();
        // SO THE LOGIN PAGE DOES NOT ASK FOR A FINGERPRINT AT ONCE.
        //
        // On an enrolled device the login page starts the Face ID prompt
        // by itself. Pressing Sign out and being asked to sign straight
        // back in is the one place where that is wrong, so the act of
        // signing out is recorded for this tab and the page reads it.
        try {
          sessionStorage.setItem(SIGNED_OUT_KEY, '1');
        } catch (err) { /* private mode: the prompt is a convenience */ }
        location.href =
          'login.html';
      }
    },

    forgotPassword(email) {
      return apiFetch(
        '/auth/forgot-password',
        {
          method: 'POST',
          body: {
            email
          },
          skipAuth: true
        }
      );
    },

    resetPassword(
      token,
      newPassword
    ) {
      return apiFetch(
        '/auth/reset-password',
        {
          method: 'POST',
          body: {
            token,
            newPassword
          },
          skipAuth: true
        }
      );
    },

    async ensureSession() {
      // The token we already hold, while it is still good. This is what
      // takes the network off the path between clicking a nav item and
      // seeing the page.
      if (haveUsableSession()) {
        return getCachedUser();
      }

      try {
        const data =
          await doRefresh();

        return data.user;
      } catch {
        clearSession();
        return null;
      }
    }
  };

  // ============================================================
  // FACE ID / FINGERPRINT
  // ============================================================
  //
  // A second way in to the SAME session: passkeys.login below ends in
  // setSession with exactly what /auth/login returns, and the server
  // sets the same refresh cookie at the same path with the same
  // lifetime. Nothing here is a different kind of sign-in.
  //
  // All the WebAuthn work is @simplewebauthn/browser's, loaded as that
  // library's own UMD bundle (window.SimpleWebAuthnBrowser). This file
  // does no crypto and never touches a key.

  function webauthn() {
    return (typeof window !== 'undefined' && window.SimpleWebAuthnBrowser) || null;
  }

  /** The accounts this device has enrolled: [{ email, name }]. */
  function enrolledAccounts() {
    try {
      const raw = localStorage.getItem(PASSKEY_ACCOUNTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter((a) => a && typeof a.email === 'string')
        : [];
    } catch (err) {
      return [];
    }
  }

  function rememberEnrolment(email, name) {
    const typed = String(email || '').trim().toLowerCase();
    if (!typed) return;
    try {
      const list = enrolledAccounts().filter((a) => a.email !== typed);
      list.unshift({ email: typed, name: String(name || '').trim() || typed });
      localStorage.setItem(PASSKEY_ACCOUNTS_KEY, JSON.stringify(list.slice(0, 8)));
    } catch (err) { /* nothing to remember it in; the offer simply repeats */ }
  }

  function forgetEnrolment(email) {
    const typed = String(email || '').trim().toLowerCase();
    try {
      localStorage.setItem(
        PASSKEY_ACCOUNTS_KEY,
        JSON.stringify(enrolledAccounts().filter((a) => a.email !== typed))
      );
    } catch (err) { /* ignore */ }
  }

  const passkeys = {
    supported() {
      const lib = webauthn();
      return !!lib && lib.browserSupportsWebAuthn();
    },

    accounts: enrolledAccounts,
    remember: rememberEnrolment,
    forget: forgetEnrolment,

    justSignedOut() {
      try {
        return sessionStorage.getItem(SIGNED_OUT_KEY) === '1';
      } catch (err) {
        return false;
      }
    },

    clearSignedOut() {
      try {
        sessionStorage.removeItem(SIGNED_OUT_KEY);
      } catch (err) { /* ignore */ }
    },

    /** A phone or a tablet, including an iPad that calls itself a Mac. */
    isMobile() {
      const ua = navigator.userAgent || '';
      if (/Android|iPhone|iPod|iPad/i.test(ua)) return true;
      // iPadOS reports Macintosh; a Mac has no touch screen.
      return /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    },

    /**
     * WHETHER THIS DEVICE CAN DO FACE ID OR A FINGERPRINT.
     *
     * isUserVerifyingPlatformAuthenticatorAvailable() is not enough on
     * its own: some Android phones answer "no" although they have a
     * working fingerprint, and keying off it alone hid the feature
     * completely on those handsets. So:
     *
     *   a phone or tablet that supports WebAuthn -> available
     *   a computer -> available when isUVPAA says yes, OR when
     *                 getClientCapabilities reports a platform or passkey
     *                 authenticator (Chrome's own password manager, with
     *                 no Windows Hello)
     *   anything else -> not available, and the page shows nothing extra
     *
     * Never by browser name. Every normal mobile browser -- Chrome,
     * Safari, Samsung Internet, Firefox, Edge, Opera, Brave -- takes the
     * first branch, because what decides it is the device.
     */
    async available() {
      if (!passkeys.supported()) return false;
      if (passkeys.isMobile()) return true;

      try {
        if (await window.PublicKeyCredential
          .isUserVerifyingPlatformAuthenticatorAvailable()) {
          return true;
        }
      } catch (err) { /* fall through to capabilities */ }

      try {
        if (typeof window.PublicKeyCredential.getClientCapabilities === 'function') {
          const caps = await window.PublicKeyCredential.getClientCapabilities();
          if (caps && (caps.userVerifyingPlatformAuthenticator
            || caps.passkeyPlatformAuthenticator)) {
            return true;
          }
        }
      } catch (err) { /* no capabilities API: not available */ }

      return false;
    },

    /**
     * A browser that cannot do passkeys at all: an app's built-in one.
     * Those visitors are told where to go rather than shown nothing.
     */
    inAppBrowser() {
      const ua = navigator.userAgent || '';
      return /; wv\)|FBAN|FBAV|Instagram|Line\/|Snapchat|Twitter|MicroMessenger|GSA\//i.test(ua);
    },

    async registerOptions() {
      const body = await apiFetch('/auth/passkey/register-options', { method: 'POST' });
      return body.data.options;
    },

    /** Enrols THIS device for the account that is already signed in. */
    async register(label) {
      const lib = webauthn();
      if (!lib) throw new ApiError('Face ID and fingerprint are not available here.', 0);

      const options = await passkeys.registerOptions();
      const response = await lib.startRegistration({ optionsJSON: options });

      const body = await apiFetch('/auth/passkey/register', {
        method: 'POST',
        body: { response, label: label || undefined }
      });
      rememberEnrolment(body.data.email, body.data.name);
      return body.data;
    },

    async loginOptions(email) {
      const body = await apiFetch('/auth/passkey/login-options', {
        method: 'POST',
        body: { email: email || undefined },
        skipAuth: true
      });
      return body.data.options;
    },

    /**
     * Signs in with Face ID or a fingerprint.
     *
     * With no email it asks for ANY passkey this site holds on the
     * device, so a key synced from another phone signs straight in.
     *
     * `conditional` is the browser's own autofill flow: the request waits
     * quietly behind the email field until the visitor picks a passkey
     * from it.
     */
    async login(email, options) {
      const lib = webauthn();
      if (!lib) throw new ApiError('Face ID and fingerprint are not available here.', 0);

      const settings = options || {};
      const requestOptions = await passkeys.loginOptions(email);
      const response = await lib.startAuthentication({
        optionsJSON: requestOptions,
        useBrowserAutofill: !!settings.conditional
      });

      const body = await apiFetch('/auth/passkey/login', {
        method: 'POST',
        body: { response },
        skipAuth: true
      });

      setSession(body.data.accessToken, body.data.user);
      passkeys.clearSignedOut();
      rememberEnrolment(body.data.user.email, body.data.user.name);
      return body.data.user;
    },

    /** Does the server hold a key for this account, on this host? */
    async status(email) {
      if (!email) return false;
      const body = await apiFetch(
        '/auth/passkey/status?email=' + encodeURIComponent(email),
        { skipAuth: true }
      );
      return !!body.data.enrolled;
    },

    supportsAutofill() {
      const lib = webauthn();
      return !!lib && lib.browserSupportsWebAuthnAutofill();
    }
  };

  // ============================================================
  // DE'VYORA LIBRARY
  // ============================================================
  //
  // ONE PICTURE PER REQUEST. "Bulk" is a hundred requests, not one with
  // a hundred files in it: the API is a serverless function with a
  // sixty-second limit and a few megabytes of request body. The page
  // sends a few at a time and reports each one, so one bad file fails on
  // its own and the rest still land.
  //
  // upload() uses XMLHttpRequest rather than fetch because it is the
  // only one that reports how much of a file has actually gone up. A
  // hundred photographs is a real wait, and a bar that only moves when a
  // file finishes is not a progress bar.

  // THE CHOSEN REFERENCE, CARRIED FORWARD.
  //
  // A client picks one picture in the library and then walks to the
  // mood board to generate from it. Those are two pages, so the choice
  // has to survive the walk.
  //
  // It is kept in localStorage, not in the URL and not in the database:
  // the URL would be lost the moment they click anything else, and a
  // column nobody has specified yet would be a schema change made on a
  // guess. What is stored is the whole small record -- id, theme, title
  // and the Drive link -- so the page that generates can show what was
  // chosen without fetching it again, and can send the id the generator
  // will resolve server-side.
  //
  // This is the carrier the generation chunk reads. If the choice ever
  // has to outlive a browser, that is a column and a migration, and the
  // shape here is already the shape it would take.
  const LIBRARY_SELECTION_KEY = 'casa_library_selection';

  const library = {
    /** The reference the client has chosen, or null. */
    selection() {
      try {
        const raw = localStorage.getItem(LIBRARY_SELECTION_KEY);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value.id === 'string' && typeof value.imageUrl === 'string'
          ? value
          : null;
      } catch (err) {
        return null;
      }
    },

    select(reference) {
      if (!reference || !reference.id) return null;
      const kept = {
        id: reference.id,
        themeId: reference.themeId || '',
        /**
         * The theme's own label, as the wizard spells it ("Roman
         * Touch", "Black & White").
         *
         * Carried as well as the id because the mood-board wizard
         * works in labels, and deriving one from an id cannot be done
         * reliably -- "black_white" is "Black & White", not "Black
         * White". The Library page has the label in hand when the
         * client clicks, so it travels from there rather than being
         * guessed at the other end. Empty for a selection made before
         * this existed, which the wizard treats as "no theme to
         * pre-select".
         */
        themeLabel: reference.themeLabel || '',
        /** The room id, as the hierarchy's second level stores it. */
        roomId: reference.roomId || '',
        /**
         * The mood-board wizard's own name for that room ("Kitchen &
         * Dining", not "kitchen"), carried for the same reason
         * themeLabel is: the wizard works in labels, and a client who
         * chose a Kitchen reference should not then have to find
         * Kitchen in the wizard themselves.
         */
        roomWizard: reference.roomWizard || '',
        title: reference.title || '',
        imageUrl: reference.imageUrl || '',
        room: reference.room || '',
        chosenAt: new Date().toISOString(),
      };
      try {
        localStorage.setItem(LIBRARY_SELECTION_KEY, JSON.stringify(kept));
      } catch (err) { /* private mode: the choice lasts this page only */ }
      return kept;
    },

    clearSelection() {
      try {
        localStorage.removeItem(LIBRARY_SELECTION_KEY);
      } catch (err) { /* ignore */ }
    },

    /**
     * The nine themes, and whether their counts could be read.
     *
     * `storage.ok` is false when the library's table is missing --
     * the themes themselves come from the studio's theme file and are
     * listed either way, which is what stops an un-migrated database
     * showing an empty page with no way in.
     */
    themes() {
      return apiFetch('/library/themes').then((r) => ({
        themes: r.data.themes || [],
        storage: r.data.storage || { ok: true, reason: '' },
        // Whether this deployment can upload at all -- asked when the
        // gallery loads, so a studio is not told after picking a
        // hundred files. Separate from `storage`, which is the
        // database: the two break for different reasons.
        uploads: r.data.uploads || { ok: true, reason: '' },
      }));
    },

    /**
     * A theme's rooms: the starters that ship with the app first, then
     * the studio's own uploads.
     *
     * `storage.ok` is false when the uploaded ones could not be read --
     * the starters are files and are returned either way, which is what
     * stops a theme opening to nothing.
     */
    /** The studio's room types, for the upload form's dropdown. */
    rooms() {
      return apiFetch('/library/rooms').then((r) => r.data.rooms || []);
    },

    references(themeId, roomId) {
      const parts = [];
      if (themeId) parts.push('themeId=' + encodeURIComponent(themeId));
      if (roomId) parts.push('roomId=' + encodeURIComponent(roomId));
      const query = parts.length ? '?' + parts.join('&') : '';
      return apiFetch('/library/references' + query).then((r) => ({
        references: r.data.references || [],
        storage: r.data.storage || { ok: true, reason: '' },
      }));
    },

    remove(id) {
      return apiFetch('/library/references/' + encodeURIComponent(id), {
        method: 'DELETE'
      }).then((r) => r.data);
    },

    /**
     * Uploads ONE picture.
     *
     * `onProgress` is called with 0..1 as the bytes go up. `signal` is an
     * AbortSignal, so a page that is left can stop a queue of ninety.
     */
    upload(file, fields, options) {
      const settings = options || {};
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        Object.keys(fields || {}).forEach((key) => {
          if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') {
            form.append(key, fields[key]);
          }
        });

        const xhr = new XMLHttpRequest();
        xhr.open('POST', API_BASE + '/library/references');
        xhr.withCredentials = true;

        const token = getAccessToken();
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

        if (settings.signal) {
          settings.signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }

        if (xhr.upload && typeof settings.onProgress === 'function') {
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) settings.onProgress(event.loaded / event.total);
          });
        }

        xhr.addEventListener('load', () => {
          let body = {};
          try { body = JSON.parse(xhr.responseText || '{}'); } catch (err) { body = {}; }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(body.data && body.data.reference);
            return;
          }
          reject(new ApiError(
            (body && body.message) || 'That picture could not be uploaded.',
            xhr.status,
            body && body.errors
          ));
        });

        xhr.addEventListener('error', () => {
          reject(new ApiError('The connection dropped while uploading.', 0));
        });
        xhr.addEventListener('abort', () => {
          reject(new ApiError('Upload cancelled.', 0));
        });

        xhr.send(form);
      });
    }
  };

  // ============================================================
  // USERS
  // ============================================================

  const users = {
    list(params) {
      return apiFetch(
        `/users${qs(params)}`
      ).then((r) => ({
        users:
          r.data.users,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/users/${id}`
      ).then(
        (r) =>
          r.data.user
      );
    },

    create(payload) {
      return apiFetch(
        '/users',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.user
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/users/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.user
      );
    },

    remove(id) {
      return apiFetch(
        `/users/${id}`,
        {
          method: 'DELETE'
        }
      );
    },

    assignRole(
      id,
      roleId
    ) {
      return apiFetch(
        `/users/${id}/role`,
        {
          method: 'PATCH',
          body: {
            roleId
          }
        }
      ).then(
        (r) =>
          r.data.user
      );
    }
  };

  // ============================================================
  // ME
  // ============================================================

  const me = {
    get() {
      return apiFetch(
        '/users/me'
      ).then(
        (r) =>
          r.data.user
      );
    },

    update(payload) {
      return apiFetch(
        '/users/me',
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.user
      );
    },

    changePassword(
      currentPassword,
      newPassword
    ) {
      return apiFetch(
        '/users/me/change-password',
        {
          method: 'POST',
          body: {
            currentPassword,
            newPassword
          }
        }
      );
    }
  };

  // ============================================================
  // ROLES
  // ============================================================

  const roles = {
    list() {
      return apiFetch(
        '/roles'
      ).then(
        (r) =>
          r.data.roles
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/roles/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.role
      );
    }
  };

  // ============================================================
  // DASHBOARD
  // ============================================================

  const dashboard = {
    stats() {
      return apiFetch(
        '/dashboard/stats'
      ).then(
        (r) =>
          r.data.stats
      );
    },

    recentActivity(limit) {
      return apiFetch(
        `/dashboard/recent-activity${qs({
          limit
        })}`
      ).then(
        (r) =>
          r.data.activity
      );
    },

    overview() {
      return apiFetch(
        '/dashboard/overview'
      ).then(
        (r) =>
          r.data
      );
    },

    collections(params) {
      return apiFetch(
        `/dashboard/collections${qs(
          params
        )}`
      ).then(
        (r) =>
          r.data
      );
    }
  };

  // ============================================================
  // CATALOG EXTRACTOR
  // ============================================================

  const catalogExtractor = {
    brands() {
      return apiFetch(
        '/catalog-extractor/brands'
      ).then(
        (r) =>
          r.data.brands
      );
    },

    upload(
      file,
      {
        brandId,
        brandName
      } = {}
    ) {
      const formData =
        new FormData();

      formData.append(
        'file',
        file
      );

      if (brandId) {
        formData.append(
          'brandId',
          brandId
        );
      }

      if (brandName) {
        formData.append(
          'brandName',
          brandName
        );
      }

      const token =
        getAccessToken();

      const headers = {};

      if (token) {
        headers.Authorization =
          `Bearer ${token}`;
      }

      return fetch(
        `${API_BASE}/catalog-extractor/upload`,
        {
          method: 'POST',
          headers,
          credentials: 'include',
          body: formData
        }
      ).then(
        async (res) => {
          const body =
            await res
              .json()
              .catch(() => ({}));

          if (!res.ok) {
            throw new ApiError(
              body.message ||
                'Upload failed',
              res.status,
              body.errors
            );
          }

          return body.data.catalog;
        }
      );
    },

    list(params) {
      return apiFetch(
        `/catalog-extractor/catalogs${qs(
          params
        )}`
      ).then((r) => ({
        catalogs:
          r.data.catalogs,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/catalog-extractor/catalogs/${id}`
      ).then(
        (r) =>
          r.data.catalog
      );
    },

    tiles(
      id,
      params
    ) {
      return apiFetch(
        `/catalog-extractor/catalogs/${id}/tiles${qs(
          params
        )}`
      ).then((r) => ({
        tiles:
          r.data.tiles,
        meta:
          r.meta
      }));
    },

    retry(id) {
      return apiFetch(
        `/catalog-extractor/catalogs/${id}/retry`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.catalog
      );
    },

    remove(
      id,
      deleteTiles
    ) {
      return apiFetch(
        `/catalog-extractor/catalogs/${id}${qs({
          deleteTiles:
            deleteTiles
              ? 'true'
              : undefined
        })}`,
        {
          method: 'DELETE'
        }
      );
    },

    updateTile(
      tileId,
      payload
    ) {
      return apiFetch(
        `/catalog-extractor/tiles/${tileId}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.tile
      );
    },

    removeTile(tileId) {
      return apiFetch(
        `/catalog-extractor/tiles/${tileId}`,
        {
          method: 'DELETE'
        }
      );
    },

    async pollUntilDone(
      id,
      onUpdate,
      {
        intervalMs = 1000,
        maxAttempts = 120
      } = {}
    ) {
      for (
        let i = 0;
        i < maxAttempts;
        i++
      ) {
        const catalog =
          await this.get(id);

        if (
          typeof onUpdate ===
          'function'
        ) {
          onUpdate(catalog);
        }

        if (
          catalog.status ===
            'COMPLETED' ||
          catalog.status ===
            'FAILED'
        ) {
          return catalog;
        }

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              intervalMs
            )
        );
      }

      return this.get(id);
    }
  };

  // ============================================================
  // DESIGN RULES
  // ============================================================

  const designRules = {
    list() {
      return apiFetch(
        '/design-rules'
      ).then(
        (r) =>
          r.data.rules
      );
    },

    get(id) {
      return apiFetch(
        `/design-rules/${id}`
      ).then(
        (r) =>
          r.data.rule
      );
    },

    create(payload) {
      return apiFetch(
        '/design-rules',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.rule
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/design-rules/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.rule
      );
    },

    remove(id) {
      return apiFetch(
        `/design-rules/${id}`,
        {
          method: 'DELETE'
        }
      );
    },

    preview() {
      return apiFetch(
        '/design-rules/preview'
      ).then(
        (r) =>
          r.data
      );
    },

    publish(changeSummary) {
      return apiFetch(
        '/design-rules/publish',
        {
          method: 'POST',
          body: {
            changeSummary
          }
        }
      ).then(
        (r) =>
          r.data.version
      );
    },

    live() {
      return apiFetch(
        '/design-rules/live'
      ).then(
        (r) =>
          r.data.version
      );
    },

    versions(params) {
      return apiFetch(
        `/design-rules/versions${qs(
          params
        )}`
      ).then((r) => ({
        versions:
          r.data.versions,
        meta:
          r.meta
      }));
    },

    getVersion(id) {
      return apiFetch(
        `/design-rules/versions/${id}`
      ).then(
        (r) =>
          r.data.version
      );
    },

    compareVersions(
      fromId,
      toId
    ) {
      return apiFetch(
        `/design-rules/versions/compare${qs({
          from: fromId,
          to: toId
        })}`
      ).then(
        (r) =>
          r.data
      );
    },

    restoreVersion(id) {
      return apiFetch(
        `/design-rules/versions/${id}/restore`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.rules
      );
    },

    removeVersion(id) {
      return apiFetch(
        `/design-rules/versions/${id}`,
        {
          method: 'DELETE'
        }
      );
    }
  };

  // ============================================================
  // REFERENCE IMAGES
  // ============================================================

  const referenceImages = {
    list(params) {
      return apiFetch(
        `/reference-images${qs(
          params
        )}`
      ).then((r) => ({
        images:
          r.data.images,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/reference-images/${id}`
      ).then(
        (r) =>
          r.data.image
      );
    },

    categories() {
      return apiFetch(
        '/reference-images/categories'
      ).then(
        (r) =>
          r.data
      );
    },

    upload(
      file,
      fields = {}
    ) {
      const formData =
        new FormData();

      formData.append(
        'file',
        file
      );

      Object.entries(fields)
        .forEach(
          ([key, value]) => {
            if (
              value !== undefined &&
              value !== null &&
              value !== ''
            ) {
              formData.append(
                key,
                value
              );
            }
          }
        );

      const token =
        getAccessToken();

      const headers = {};

      if (token) {
        headers.Authorization =
          `Bearer ${token}`;
      }

      return fetch(
        `${API_BASE}/reference-images`,
        {
          method: 'POST',
          headers,
          credentials: 'include',
          body: formData
        }
      ).then(
        async (res) => {
          const body =
            await res
              .json()
              .catch(() => ({}));

          if (!res.ok) {
            throw new ApiError(
              body.message ||
                'Upload failed',
              res.status,
              body.errors
            );
          }

          return body.data.image;
        }
      );
    },

    replaceImage(
      id,
      file
    ) {
      const formData =
        new FormData();

      formData.append(
        'file',
        file
      );

      const token =
        getAccessToken();

      const headers = {};

      if (token) {
        headers.Authorization =
          `Bearer ${token}`;
      }

      return fetch(
        `${API_BASE}/reference-images/${id}/image`,
        {
          method: 'PUT',
          headers,
          credentials: 'include',
          body: formData
        }
      ).then(
        async (res) => {
          const body =
            await res
              .json()
              .catch(() => ({}));

          if (!res.ok) {
            throw new ApiError(
              body.message ||
                'Replace failed',
              res.status,
              body.errors
            );
          }

          return body.data.image;
        }
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/reference-images/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.image
      );
    },

    remove(id) {
      return apiFetch(
        `/reference-images/${id}`,
        {
          method: 'DELETE'
        }
      );
    }
  };

  // ============================================================
  // MOOD BOARDS
  // ============================================================

  const moodBoards = {
    /**
     * The mood board as a PDF, at the chosen physical size.
     *
     * Not routed through apiFetch because that parses JSON; this
     * response is the file itself. The session handling is the same --
     * ensureSession first, so the Authorization header carries a token
     * that is actually current.
     */
    async exportPdf(payload) {
      await auth.ensureSession();

      const res = await fetch(
        `${API_BASE}/mood-boards/export-pdf`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(getAccessToken()
              ? { Authorization: `Bearer ${getAccessToken()}` }
              : {})
          },
          body: JSON.stringify(payload)
        }
      );

      if (!res.ok) {
        // An error here is JSON, whatever the success case returns.
        const problem =
          await res
            .json()
            .catch(() => ({}));

        throw new ApiError(
          (problem &&
            problem.message) ||
            `Could not build the PDF (${res.status})`,
          res.status
        );
      }

      return res.blob();
    },

    generate(payload) {
      return apiFetch(
        '/mood-boards/generate',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data
      );
    },

    save(payload) {
      return apiFetch(
        '/mood-boards',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    list(params) {
      return apiFetch(
        `/mood-boards${qs(
          params
        )}`
      ).then((r) => ({
        boards:
          r.data.boards,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/mood-boards/${id}`
      ).then(
        (r) =>
          r.data.board
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/mood-boards/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    remove(id) {
      return apiFetch(
        `/mood-boards/${id}`,
        {
          method: 'DELETE'
        }
      );
    },

    approve(
      id,
      selectedIndex
    ) {
      return apiFetch(
        `/mood-boards/${id}/approve`,
        {
          method: 'POST',
          body: {
            selectedIndex
          }
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    tiles(ids) {
      return apiFetch(
        `/mood-boards/tiles${qs({
          ids: ids.join(',')
        })}`
      ).then(
        (r) =>
          r.data.tiles
      );
    },

    share(id) {
      return apiFetch(
        `/mood-boards/${id}/share`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    }
  };

  // ============================================================
  // SHARED (public, token-based Client Share/Approve — no auth,
  // no requireAuth() gate; used only by shared.html)
  // ============================================================

  const shared = {
    get(token) {
      return apiFetch(
        `/mood-boards/shared/${encodeURIComponent(token)}`,
        {
          skipAuth: true
        }
      ).then(
        (r) =>
          r.data
      );
    },

    respond(token, response) {
      return apiFetch(
        `/mood-boards/shared/${encodeURIComponent(token)}/respond`,
        {
          method: 'POST',
          skipAuth: true,
          body: {
            response
          }
        }
      ).then(
        (r) =>
          r.data
      );
    }
  };

  // ============================================================
  // TILES (plain browse/search — Catalog page's Surface Archive.
  // Distinct from moodBoards.tiles() above, which resolves specific
  // ids referenced by a generated combination.)
  // ============================================================

  const tiles = {
    /** The floor-module sizes the catalog actually stocks. */
    sizes() {
      return apiFetch(
        '/tiles/sizes'
      ).then(
        (r) =>
          r.data.sizes
      );
    },

    list(params) {
      return apiFetch(
        `/tiles${qs(
          params
        )}`
      ).then((r) => ({
        tiles:
          r.data.tiles,
        meta:
          r.meta
      }));
    }
  };

  // ============================================================
  // PRINT BOARDS
  // ============================================================

  const printBoards = {
    generate(payload) {
      return apiFetch(
        '/print-boards/generate',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    list(params) {
      return apiFetch(
        `/print-boards${qs(
          params
        )}`
      ).then((r) => ({
        boards:
          r.data.boards,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/print-boards/${id}`
      ).then(
        (r) =>
          r.data.board
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/print-boards/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    remove(id) {
      return apiFetch(
        `/print-boards/${id}`,
        {
          method: 'DELETE'
        }
      );
    },

    share(id) {
      return apiFetch(
        `/print-boards/${id}/share`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.board
      );
    },

    templates: {
      list() {
        return apiFetch(
          '/print-boards/templates'
        ).then(
          (r) =>
            r.data.templates
        );
      },

      create(payload) {
        return apiFetch(
          '/print-boards/templates',
          {
            method: 'POST',
            body: payload
          }
        ).then(
          (r) =>
            r.data.template
        );
      },

      remove(id) {
        return apiFetch(
          `/print-boards/templates/${id}`,
          {
            method: 'DELETE'
          }
        );
      }
    }
  };

  // ============================================================
  // API KEYS
  // ============================================================

  const apiKeys = {
    list(service) {
      const query =
        service
          ? `?service=${encodeURIComponent(
              service
            )}`
          : '';

      return apiFetch(
        `/admin/api-keys${query}`
      ).then(
        (r) =>
          r.data.keys
      );
    },

    create(payload) {
      return apiFetch(
        '/admin/api-keys',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.key
      );
    },

    rotate(
      id,
      value
    ) {
      return apiFetch(
        `/admin/api-keys/${id}/rotate`,
        {
          method: 'POST',
          body: {
            value
          }
        }
      ).then(
        (r) =>
          r.data.key
      );
    },

    activate(id) {
      return apiFetch(
        `/admin/api-keys/${id}/activate`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.key
      );
    },

    deactivate(id) {
      return apiFetch(
        `/admin/api-keys/${id}/deactivate`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.key
      );
    },

    deactivateAll() {
      return apiFetch(
        '/admin/api-keys/deactivate-all',
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    },

    remove(id) {
      return apiFetch(
        `/admin/api-keys/${id}`,
        {
          method: 'DELETE'
        }
      );
    }
  };

  // ============================================================
  // ADMIN
  // ============================================================

  const admin = {
    logs(params = {}) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        logs:
          r.data.logs,
        meta:
          r.meta
      }));
    },

    logActions() {
      return apiFetch(
        '/admin/logs/actions'
      ).then(
        (r) =>
          r.data.actions
      );
    },

    loginHistory(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs/login-history${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        attempts:
          r.data.attempts,
        meta:
          r.meta
      }));
    },

    errorLogs(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs/errors${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        errors:
          r.data.errors,
        meta:
          r.meta
      }));
    },

    catalogLogs(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs/catalog${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        catalogs:
          r.data.catalogs,
        meta:
          r.meta
      }));
    },

    moodBoardLogs(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs/mood-boards${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        logs:
          r.data.logs,
        meta:
          r.meta
      }));
    },

    printBoardLogs(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/logs/print-boards${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        logs:
          r.data.logs,
        meta:
          r.meta
      }));
    },

    analytics(days) {
      const query =
        days
          ? `?days=${encodeURIComponent(
              days
            )}`
          : '';

      return apiFetch(
        `/admin/analytics${query}`
      ).then(
        (r) =>
          r.data
      );
    },

    queueStats() {
      return apiFetch(
        '/admin/queues'
      ).then(
        (r) =>
          r.data
      );
    },

    queueJobs(
      params = {}
    ) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/admin/queues/jobs${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        jobs:
          r.data.jobs,
        meta:
          r.meta
      }));
    },

    retryJob(id) {
      return apiFetch(
        `/admin/queues/jobs/${id}/retry`,
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data.job
      );
    }
  };

  // ============================================================
  // SETTINGS
  // ============================================================

  const settings = {
    getAll() {
      return apiFetch(
        '/settings'
      ).then(
        (r) =>
          r.data.settings
      );
    },

    getCategory(category) {
      return apiFetch(
        `/settings/${category}`
      ).then(
        (r) =>
          r.data.settings
      );
    },

    updateCategory(
      category,
      payload
    ) {
      return apiFetch(
        `/settings/${category}`,
        {
          method: 'PUT',
          body: payload
        }
      ).then(
        (r) =>
          r.data.settings
      );
    }
  };

  // ============================================================
  // CUSTOMERS
  // ============================================================

  const customers = {
    list(params = {}) {
      const query =
        new URLSearchParams(
          params
        ).toString();

      return apiFetch(
        `/customers${
          query
            ? `?${query}`
            : ''
        }`
      ).then((r) => ({
        customers:
          r.data.customers,
        meta:
          r.meta
      }));
    },

    get(id) {
      return apiFetch(
        `/customers/${id}`
      ).then(
        (r) =>
          r.data.customer
      );
    },

    create(payload) {
      return apiFetch(
        '/customers',
        {
          method: 'POST',
          body: payload
        }
      ).then(
        (r) =>
          r.data.customer
      );
    },

    update(
      id,
      payload
    ) {
      return apiFetch(
        `/customers/${id}`,
        {
          method: 'PATCH',
          body: payload
        }
      ).then(
        (r) =>
          r.data.customer
      );
    },

    remove(id) {
      return apiFetch(
        `/customers/${id}`,
        {
          method: 'DELETE'
        }
      );
    },

    history(id) {
      return apiFetch(
        `/customers/${id}/history`
      ).then(
        (r) =>
          r.data.moodBoards
      );
    },

    favorites(id) {
      return apiFetch(
        `/customers/${id}/favorites`
      ).then(
        (r) =>
          r.data.favorites
      );
    },

    addFavorite(
      id,
      tileId,
      note
    ) {
      return apiFetch(
        `/customers/${id}/favorites`,
        {
          method: 'POST',
          body: {
            tileId,
            note
          }
        }
      ).then(
        (r) =>
          r.data.favorite
      );
    },

    removeFavorite(
      id,
      tileId
    ) {
      return apiFetch(
        `/customers/${id}/favorites/${tileId}`,
        {
          method: 'DELETE'
        }
      );
    }
  };

 // ============================================================
// AI VISUALIZATION
// ============================================================

/**
 * Convert a backend/Python image path or URL
 * into a browser-accessible URL.
 *
 * Supports:
 *   - http://...
 *   - https://...
 *   - data:image/...
 *   - blob:...
 *   - /static/...
 *   - Windows filesystem paths
 *   - Python output paths
 */
function resolveBackendImageUrl(imagePath) {
  if (!imagePath) {
    return '';
  }

  const value =
    String(imagePath).trim();

  if (!value) {
    return '';
  }

  // ----------------------------------------------------------
  // Already browser-accessible
  // ----------------------------------------------------------

  if (
    /^https?:\/\//i.test(value) ||
    value.startsWith('data:') ||
    value.startsWith('blob:')
  ) {
    return value;
  }

  // ----------------------------------------------------------
  // Backend base URL
  // ----------------------------------------------------------

  const backendBase =
    API_BASE.replace(
      /\/api\/v1\/?$/,
      ''
    );

  // ----------------------------------------------------------
  // Normalize Windows paths
  // ----------------------------------------------------------

  const normalized =
    value.replace(
      /\\/g,
      '/'
    );

  // ----------------------------------------------------------
  // Express static paths
  // ----------------------------------------------------------

  if (
    normalized.startsWith(
      '/static/'
    )
  ) {
    return (
      backendBase +
      normalized
    );
  }

  // ----------------------------------------------------------
  // Generated visualization paths
  // ----------------------------------------------------------

  const markers = [
    '/tile_visualizations/',
    '/visualizations/',
    'tile_visualizations/',
    'visualizations/',
    '/generated-visualizations/',
    'generated-visualizations/'
  ];

  for (
    const marker of markers
  ) {
    const index =
      normalized.indexOf(
        marker
      );

    if (index >= 0) {
      const relativePath =
        normalized.slice(
          index +
            marker.length
        );

      if (!relativePath) {
        return '';
      }

      /*
       * IMPORTANT:
       *
       * The backend currently exposes generated images
       * through the static visualization route.
       */
      return (
        `${backendBase}` +
        `/static/visualizations/` +
        relativePath
          .split('/')
          .map(
            (part) =>
              encodeURIComponent(
                part
              )
          )
          .join('/')
      );
    }
  }

  // ----------------------------------------------------------
  // Data URL
  // ----------------------------------------------------------

  if (
    normalized.startsWith(
      'data:image/'
    )
  ) {
    return normalized;
  }

  // ----------------------------------------------------------
  // Absolute filesystem path
  // ----------------------------------------------------------

  /*
   * Python can return something like:
   *
   * C:/De’vyora/catalog_processor/output/...
   *
   * Never expose the Windows filesystem path directly
   * to the browser.
   *
   * Instead try to locate the generated visualization
   * portion of the path.
   */

  const outputMarkers = [
    '/output/',
    '/output\\',
    '/tile_visualizations/',
    '/visualizations/'
  ];

  for (
    const marker of outputMarkers
  ) {
    const index =
      normalized.toLowerCase()
        .indexOf(
          marker.toLowerCase()
        );

    if (index >= 0) {
      const relative =
        normalized.slice(
          index + marker.length
        );

      if (relative) {
        return (
          `${backendBase}` +
          `/static/visualizations/` +
          relative
            .split('/')
            .map(
              (part) =>
                encodeURIComponent(
                  part
                )
            )
            .join('/')
        );
      }
    }
  }

  // ----------------------------------------------------------
  // Last-resort backend path
  // ----------------------------------------------------------

  return (
    `${backendBase}/` +
    normalized.replace(
      /^\/+/,
      ''
    )
  );
}


// ============================================================
// NORMALIZE SCENE IMAGE
// ============================================================

/**
 * Resolve an actual bathroom scene image.
 *
 * IMPORTANT:
 *
 * scene_id such as:
 *
 *     feminine_01
 *     SEED_feminine_01
 *
 * is NOT an image path.
 *
 * It must NEVER be converted into:
 *
 *     https://drive.google.com/uc?id=SEED_feminine_01
 *
 * If there is no actual image URL/path,
 * Python will generate a random bathroom scene.
 */
function resolveSceneImagePath(payload) {
  if (!payload) {
    return '';
  }

  const candidates = [
    payload.scene_image_path,
    payload.scene_image_url,
    payload.sceneImagePath,
    payload.sceneImageUrl,
    payload.scene_image,
    payload.sceneImage,
    payload.image_url,
    payload.imageUrl,
    payload.bathroom_image_url,
    payload.bathroomImageUrl
  ];

  for (
    const candidate of candidates
  ) {
    if (
      candidate === undefined ||
      candidate === null
    ) {
      continue;
    }

    const value =
      String(candidate).trim();

    if (!value) {
      continue;
    }

    /*
     * --------------------------------------------------------
     * CRITICAL FIX
     * --------------------------------------------------------
     *
     * Never accept fake scene identifiers as image paths.
     *
     * Examples:
     *
     * feminine_01
     * SEED_feminine_01
     * seed_feminine_01
     *
     * These are scene IDs, not image files. This also catches
     * the case where a placeholder ID has already been wrapped
     * into a Drive URL server-side, e.g.
     * https://drive.google.com/uc?id=SEED_feminine_01 — which is
     * exactly what seeded reference images return and is NOT a
     * real, fetchable Drive file. Without unwrapping the id=
     * param first, that URL passes the bare startsWith() checks
     * below and gets sent on to Python as a real reference image.
     */

    const driveIdMatch =
      value.match(/[?&]id=([^&]+)/i) ||
      value.match(/\/d\/([^/]+)/i);

    const placeholderCandidate = (
      driveIdMatch ? driveIdMatch[1] : value
    ).toLowerCase();

    if (
      placeholderCandidate.startsWith(
        'seed_'
      ) ||
      placeholderCandidate.startsWith(
        'scene_'
      ) ||
      placeholderCandidate === 'feminine_01' ||
      placeholderCandidate === 'feminine_02' ||
      placeholderCandidate === 'masculine_01' ||
      placeholderCandidate === 'masculine_02'
    ) {
      continue;
    }

    // A plain ID without an extension/path is not an image.
    if (
      !/^https?:\/\//i.test(value) &&
      !/^data:image\//i.test(value) &&
      !/^blob:/i.test(value) &&
      !/[\/\\]/.test(value) &&
      !/\.(png|jpe?g|webp|bmp|gif)$/i.test(value)
    ) {
      continue;
    }

    return value.replace(
      /\\/g,
      '/'
    );
  }

  return '';
}


// ============================================================
// AI API
// ============================================================

const ai = {

  /**
   * Generate bathroom/interior visualization.
   *
   * FLOW:
   *
   * Frontend
   *    ↓
   * Node /api/v1/ai/visualizations
   *    ↓
   * Python AI
   *    ↓
   * Random bathroom scene OR supplied reference
   *    ↓
   * Selected product
   *    ↓
   * Gemini / visualization pipeline
   *    ↓
   * Generated bathroom image
   */

  async generateVisualization(
    payload
  ) {

    // ========================================================
    // VALIDATION
    // ========================================================

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new ApiError(
        'Visualization payload is required.',
        400
      );
    }

    const productId =
      typeof payload.product_id ===
      'string'
        ? payload.product_id.trim()
        : '';

    const surface =
      typeof payload.surface ===
      'string'
        ? payload.surface.trim()
        : '';

    if (!productId) {
      throw new ApiError(
        'product_id is required.',
        400
      );
    }

    if (!surface) {
      throw new ApiError(
        'surface is required.',
        400
      );
    }

    // ========================================================
    // SCENE IMAGE
    // ========================================================

    const sceneImagePath =
      resolveSceneImagePath(
        payload
      );

    /*
     * IMPORTANT:
     *
     * scene_id is only metadata.
     *
     * Example:
     *
     * scene_id = "SEED_feminine_01"
     *
     * DOES NOT mean:
     *
     * scene_image_path =
     * "https://drive.google.com/..."
     *
     * If sceneImagePath is empty, Python creates
     * a fresh bathroom scene.
     */

    const sceneId =
      typeof payload.scene_id ===
        'string' &&
      payload.scene_id.trim()
        ? payload.scene_id.trim()
        : undefined;

    const hasReferenceImage =
      Boolean(
        sceneImagePath
      );

    // ========================================================
    // NORMALIZED PAYLOAD
    // ========================================================

    const normalizedPayload = {

      product_id:
        productId,

      surface:
        surface.toUpperCase(),

      /*
       * Empty string is intentionally allowed.
       *
       * Python interprets this as:
       *
       * "generate a bathroom scene"
       */
      scene_image_path:
        sceneImagePath || '',

      /*
       * Only send an actual image URL here.
       */
      scene_image_url:
        sceneImagePath || '',

      /*
       * If an actual image exists:
       *
       * reference
       *
       * Otherwise:
       *
       * random
       */
      scene_image_mode:
        hasReferenceImage
          ? 'reference'
          : 'random',

      /*
       * Explicitly request random scene when
       * no real image exists.
       */
      generate_random_scene:
        !hasReferenceImage,

      /*
       * Scene ID is metadata only.
       */
      scene_id:
        sceneId,

      theme:
        typeof payload.theme ===
          'string' &&
        payload.theme.trim()
          ? payload.theme.trim()
          : undefined,

      requirements:
        payload.requirements &&
        typeof payload.requirements ===
          'object' &&
        !Array.isArray(
          payload.requirements
        )
          ? payload.requirements
          : {}
    };

    // ========================================================
    // MASTER / PRODUCT INFORMATION
    // ========================================================

    if (
      payload.spreadsheet_id
    ) {
      normalizedPayload.spreadsheet_id =
        String(
          payload.spreadsheet_id
        ).trim();
    }

    if (
      payload.sheet_name
    ) {
      normalizedPayload.sheet_name =
        String(
          payload.sheet_name
        ).trim();
    }

    if (
      payload.product_name
    ) {
      normalizedPayload.product_name =
        String(
          payload.product_name
        ).trim();
    }

    if (
      payload.room
    ) {
      normalizedPayload.room =
        payload.room;
    }

    if (
      payload.style
    ) {
      normalizedPayload.style =
        payload.style;
    }

    if (
      payload.bathroom
    ) {
      normalizedPayload.bathroom =
        payload.bathroom;
    }

    if (
      payload.combination
    ) {
      normalizedPayload.combination =
        payload.combination;
    }

    /*
     * THE CLIENT'S CHOSEN DE'VYORA LIBRARY ROOM.
     *
     * Its ID and nothing else. The server reads that row and uses the
     * URL IT holds as the scene image -- deliberately not a URL from
     * here, which would let this page tell the server's own fetcher
     * where to go.
     *
     * When this is set, scene_image_mode and generate_random_scene
     * above are both overridden server-side: the chosen photograph IS
     * the room, so the step that invents one does not run.
     */
    if (
      typeof payload.library_reference_id ===
        'string' &&
      payload.library_reference_id.trim()
    ) {
      normalizedPayload.library_reference_id =
        payload.library_reference_id.trim();
    }

    /*
     * THE REST OF THE MOOD-BOARD COMBINATION.
     *
     * product_id above is the BASE tile only. A board also carries a
     * highlight and an accent, and sending just the base is why the
     * generated bathroom only ever showed one material.
     *
     * Only ids and roles travel; the backend resolves each id to that
     * tile's current image, so the scene is always generated from the
     * latest extracted image rather than whatever this page happened to
     * render with.
     */
    if (
      Array.isArray(
        payload.materials
      ) &&
      payload.materials.length
    ) {
      normalizedPayload.materials =
        payload.materials
          .filter(
            (material) =>
              material &&
              typeof material === 'object'
          )
          .map(
            (material) => ({
              role:
                String(
                  material.role || ''
                )
                  .trim()
                  .toLowerCase(),

              tile_id:
                String(
                  material.tile_id ||
                  material.tileId ||
                  material.product_id ||
                  ''
                ).trim()
            })
          )
          .filter(
            (material) =>
              material.tile_id
          );
    }

    // ========================================================
    // CALL NODE BACKEND
    // ========================================================

    let response;

    try {

      response =
        await apiFetch(
          '/ai/visualizations',
          {
            method: 'POST',

            body:
              normalizedPayload
          }
        );

    } catch (error) {

      if (
        error instanceof ApiError
      ) {
        throw error;
      }

      throw new ApiError(
        error instanceof Error
          ? error.message
          : 'AI visualization request failed.',
        500
      );
    }

    // ========================================================
    // NORMALIZE BACKEND RESPONSE
    // ========================================================

    const data =
      response?.data &&
      typeof response.data ===
        'object' &&
      !Array.isArray(
        response.data
      )
        ? response.data
        : response;

    const visualization =
      data?.visualization &&
      typeof data.visualization ===
        'object' &&
      !Array.isArray(
        data.visualization
      )
        ? data.visualization
        : {};

    const image =
      data?.image &&
      typeof data.image ===
        'object' &&
      !Array.isArray(
        data.image
      )
        ? data.image
        : {};

    // ========================================================
    // FIND GENERATED IMAGE
    // ========================================================

    const rawImagePath =
      image.url ||
      image.data_url ||
      image.dataUrl ||
      image.image_url ||
      image.imageUrl ||

      data?.image_url ||
      data?.imageUrl ||
      data?.image_path ||
      data?.imagePath ||
      data?.data_url ||
      data?.dataUrl ||

      visualization.url ||
      visualization.data_url ||
      visualization.dataUrl ||
      visualization.image_url ||
      visualization.imageUrl ||
      visualization.image_path ||
      visualization.imagePath ||
      visualization.path ||

      response?.image?.url ||
      response?.image?.data_url ||
      response?.image?.dataUrl ||
      response?.image?.image_url ||
      response?.image?.imageUrl ||

      response?.image_url ||
      response?.imageUrl ||
      response?.image_path ||
      response?.imagePath ||

      '';

    // ========================================================
    // CONVERT TO BROWSER URL
    // ========================================================

    const imageUrl =
      resolveBackendImageUrl(
        rawImagePath
      );

    // ========================================================
    // BUILD NORMALIZED RESULT
    // ========================================================

    const normalizedResult = {

      ...response,

      success:
        response?.success !==
        false,

      data: {

        ...data,

        visualization: {

          ...visualization,

          image_path:
            visualization.image_path ||
            rawImagePath ||
            undefined,

          image_url:
            imageUrl ||
            visualization.image_url ||
            undefined,

          imageUrl:
            imageUrl ||
            visualization.imageUrl ||
            undefined
        },

        image: {

          ...image,

          url:
            imageUrl ||
            image.url ||
            undefined,

          image_url:
            imageUrl ||
            image.image_url ||
            undefined,

          imageUrl:
            imageUrl ||
            image.imageUrl ||
            undefined,

          data_url:
            image.data_url ||
            image.dataUrl ||
            (
              typeof rawImagePath ===
              'string' &&
              rawImagePath.startsWith(
                'data:image/'
              )
                ? rawImagePath
                : undefined
            ),

          generated:
            Boolean(
              imageUrl
            )
        },

        image_url:
          imageUrl ||
          data?.image_url ||
          undefined,

        imageUrl:
          imageUrl ||
          data?.imageUrl ||
          undefined,

        image_path:
          rawImagePath ||
          data?.image_path ||
          undefined
      },

      imageUrl:
        imageUrl ||
        response?.imageUrl ||
        response?.image_url ||
        undefined,

      image_url:
        imageUrl ||
        response?.image_url ||
        undefined,

      image_path:
        rawImagePath ||
        response?.image_path ||
        undefined,

      visualization: {

        ...visualization,

        image_path:
          visualization.image_path ||
          rawImagePath ||
          undefined,

        image_url:
          imageUrl ||
          visualization.image_url ||
          undefined,

        imageUrl:
          imageUrl ||
          visualization.imageUrl ||
          undefined
      }
    };

    // ========================================================
    // HARD VALIDATION
    // ========================================================

    if (
      !normalizedResult.imageUrl &&
      !normalizedResult.data?.image?.url &&
      !normalizedResult.data?.visualization?.image_url
    ) {

      /*
       * Do NOT silently report success if Python
       * returned no image.
       */

      throw new ApiError(
        'AI visualization completed but no generated image was returned by the backend.',
        502,
        normalizedResult
      );
    }

    return normalizedResult;
  },


  // ========================================================
  // GENERATE IMAGE URL
  // ========================================================

  async recentGenerations(
    limit
  ) {
    const query =
      limit
        ? `?limit=${limit}`
        : '';

    return apiFetch(
      `/ai/visualizations/recent${query}`
    ).then(
      (r) =>
        r.data
          .generations
    );
  },

  /**
   * One page of the history, with what follows it.
   *
   * recentGenerations above returns the generations alone and is left
   * exactly as it was, so nothing that calls it has to change. This is
   * for the caller that has to show EVERY generation: it returns
   * `nextCursor` to ask for the next page with, and `total` so the page
   * can say how many there are rather than implying the first screenful
   * is all of them.
   */
  /**
   * One stored scene, as something an <img> can show.
   *
   * The history list sends a PATH rather than the picture. A generated
   * scene is kept as an inline data: URL of a megabyte or two, and sixty
   * of those in one response is the whole of why Recent Generations took
   * so long to open. The bytes sit behind the bearer token, which an
   * `<img src>` cannot send, so they are fetched here and handed back as
   * an object URL.
   *
   * One refresh-and-retry on 401, the same as every other call: a page
   * left open past the access token's fifteen minutes should still be
   * able to show a picture when it is scrolled.
   */
  async recentGenerationImage(path, _retried) {
    const token = getAccessToken();

    const res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include'
    });

    if (res.status === 401 && !_retried) {
      await doRefresh();
      return ai.recentGenerationImage(path, true);
    }

    if (!res.ok) {
      throw new ApiError('Could not load this scene.', res.status);
    }

    return URL.createObjectURL(await res.blob());
  },

  async recentGenerationsPage(
    options
  ) {
    const { cursor, limit } =
      options || {};

    const query = [];
    if (limit) query.push(`limit=${encodeURIComponent(limit)}`);
    if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);

    const data = (
      await apiFetch(
        `/ai/visualizations/recent${query.length ? '?' + query.join('&') : ''}`
      )
    ).data;

    return {
      generations: data.generations || [],
      nextCursor: data.nextCursor || null,
      total: typeof data.total === 'number' ? data.total : null,
    };
  },

  /**
   * The generated scene, together with the backend's own verdict on
   * whether it came back as the theme that was asked for.
   *
   * generateImageUrl below returns the URL alone and is left exactly as
   * it was, so nothing that calls it has to change. This is for the
   * caller that wants the verdict too -- the mood board, which shows it
   * rather than letting a handsome generic bathroom pass as a finished
   * board.
   *
   * themeCheck.status is "pass", "fail" or "unchecked". "unchecked" is
   * never a pass: it means the check could not run.
   */
  async generateScene(
    payload
  ) {

    const result =
      await this.generateVisualization(
        payload
      );

    return {
      imageUrl: this.imageUrlFrom(result),
      themeCheck:
        result.theme_check ||
        result.data?.theme_check ||
        null,
    };
  },

  imageUrlFrom(
    result
  ) {

    return (
      result.imageUrl ||
      result.image_url ||
      result.data?.image?.url ||
      result.data?.image?.image_url ||
      result.data?.image?.data_url ||
      result.data?.visualization?.image_url ||
      result.data?.visualization?.imageUrl ||
      ''
    );
  },

  async generateImageUrl(
    payload
  ) {

    return this.imageUrlFrom(
      await this.generateVisualization(
        payload
      )
    );
  },


  // ========================================================
  // AI HEALTH
  // ========================================================

  health() {

    return apiFetch(
      '/ai/health'
    );
  },


  // ========================================================
  // SIMPLE TEST
  // ========================================================

  async test(
    payload
  ) {

    return this.generateVisualization(
      payload
    );
  }
};

  // ============================================================
  // AUTH GUARD
  // ============================================================

  async function requireAuth(
    allowedRoles
  ) {
    const user =
      await auth.ensureSession();

    if (!user) {
      redirectToLogin();

      return new Promise(
        () => {}
      );
    }

    if (
      allowedRoles &&
      !allowedRoles.includes(
        user.role
      )
    ) {
      alert(
        "You don't have permission to view this page."
      );

      // Route staff back to the actual tool (their only real home) and
      // everyone else to the dashboard — never back into another
      // admin-only page, or a STAFF user denied on any admin page would
      // bounce endlessly between two pages that both reject them.
      location.href =
        user.role === 'STAFF'
          ? 'tool-dashboard.html'
          : 'admin-dashboard.html';

      return new Promise(
        () => {}
      );
    }

    return user;
  }

  // ============================================================
  // UI HELPERS
  // ============================================================

  function initials(name) {
    return (
      name || ''
    )
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(
        (part) =>
          part[0]
            .toUpperCase()
      )
      .join('');
  }

  function relativeTime(
    dateStr
  ) {
    if (!dateStr) {
      return 'Never';
    }

    const then =
      new Date(
        dateStr
      ).getTime();

    const diffMs =
      Date.now() -
      then;

    const mins =
      Math.floor(
        diffMs /
        60000
      );

    if (mins < 1) {
      return 'Just now';
    }

    if (mins < 60) {
      return `${mins} minute${
        mins === 1
          ? ''
          : 's'
      } ago`;
    }

    const hrs =
      Math.floor(
        mins / 60
      );

    if (hrs < 24) {
      return `${hrs} hour${
        hrs === 1
          ? ''
          : 's'
      } ago`;
    }

    const days =
      Math.floor(
        hrs / 24
      );

    if (days < 7) {
      return `${days} day${
        days === 1
          ? ''
          : 's'
      } ago`;
    }

    return new Date(
      dateStr
    ).toLocaleDateString();
  }

  // ============================================================
  // GEMINI
  // ============================================================

  function geminiStatus() {
    return apiFetch(
      '/integrations/gemini/status'
    ).then(
      (r) =>
        r.data
    );
  }

  function testGeminiConnection() {
    return apiFetch(
      '/integrations/gemini/test',
      {
        method: 'POST'
      }
    ).then(
      (r) =>
        r.data
    );
  }

  // ============================================================
  // GOOGLE DRIVE
  // ============================================================

  function driveStatus() {
    return apiFetch(
      '/integrations/drive/status'
    ).then(
      (r) =>
        r.data
    );
  }

  function testDriveConnection() {
    return apiFetch(
      '/integrations/drive/test',
      {
        method: 'POST'
      }
    ).then(
      (r) =>
        r.data
    );
  }

  // ============================================================
  // GOOGLE OAUTH -- connecting the studio's own Google account
  // ============================================================
  //
  // A service account owns no Drive storage, so it cannot put a file
  // in a personal My Drive. These are the owner-only calls that
  // connect the studio's own account instead. No secret ever comes
  // back: `status` says whether a token exists, never what it is, and
  // the Picker token is short-lived and only for the Picker.

  const googleDrive = {
    status() {
      return apiFetch(
        '/integrations/google/status'
      ).then(
        (r) =>
          r.data
      );
    },

    connect() {
      return apiFetch(
        '/integrations/google/connect',
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    },

    disconnect() {
      return apiFetch(
        '/integrations/google/disconnect',
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    },

    pickerToken() {
      return apiFetch(
        '/integrations/google/picker-token',
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    },

    /** Folder, Theme/Room tree, a real upload, a public link, cleanup. */
    selfTest() {
      return apiFetch(
        '/integrations/drive/self-test',
        {
          method: 'POST'
        }
      ).then(
        (r) =>
          r.data
      );
    }
  };

  // ============================================================
  // PYTHON AI SERVICE
  // ============================================================

  function pythonAiStatus() {
    return apiFetch(
      '/integrations/python-ai/status'
    ).then(
      (r) =>
        r.data
    );
  }

  function testPythonAiConnection() {
    return apiFetch(
      '/integrations/python-ai/test',
      {
        method: 'POST'
      }
    ).then(
      (r) =>
        r.data
    );
  }

  // ============================================================
  // FINAL PUBLIC API
  // ============================================================

  window.CasaApi = {
    ApiError,

    auth,

    passkeys,

    library,

    users,

    me,

    roles,

    dashboard,

    catalogExtractor,

    designRules,

    referenceImages,

    moodBoards,

    shared,

    tiles,

    printBoards,

    apiKeys,

    admin,

    settings,

    customers,

    ai,

    resolveBackendImageUrl,

    resolveSceneImagePath,

    geminiStatus,

    testGeminiConnection,

    driveStatus,

    testDriveConnection,

    googleDrive,

    pythonAiStatus,

    testPythonAiConnection,

    requireAuth,

    getCachedUser,

    initials,

    relativeTime
  };

})();