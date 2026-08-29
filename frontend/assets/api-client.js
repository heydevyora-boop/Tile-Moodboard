/**
 * Casa de Aurum — shared frontend API client.
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
    'http://localhost:5000/api/v1';

  const ACCESS_TOKEN_KEY = 'casa_access_token';
  const USER_KEY = 'casa_user';

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
   * C:/Casa De Aurum/catalog_processor/output/...
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

  async generateImageUrl(
    payload
  ) {

    const result =
      await this.generateVisualization(
        payload
      );

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
        user.role?.name
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
        user.role?.name === 'STAFF'
          ? '00-casa-de-aurum-tool-REFERENCE.html'
          : 'dashboard.html';

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
  // FINAL PUBLIC API
  // ============================================================

  window.CasaApi = {
    ApiError,

    auth,

    users,

    me,

    roles,

    dashboard,

    catalogExtractor,

    designRules,

    referenceImages,

    moodBoards,

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

    requireAuth,

    getCachedUser,

    initials,

    relativeTime
  };

})();