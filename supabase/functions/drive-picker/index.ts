// drive-picker - Supabase Edge Function (public, no auth).
//
// Serves a self-contained HTML page that hosts the Google Picker JS API.
// Loaded inside a react-native-webview (src/components/DrivePickerModal.tsx).
// The page reads the user's Google OAuth access token from
// `window.__ZOLVA_OAUTH_TOKEN`, which the WebView injects via
// injectedJavaScriptBeforeContentLoaded BEFORE this page's scripts run -
// so the token never travels in a URL or to this function.
//
// Under the `drive.file` scope the Picker still lets the user browse their
// full Drive; selecting a file is what grants the app per-file access. The
// grant attaches to the OAuth *client*, so the server agent (same client)
// can read picked files too.
//
// Why an edge function (vs a static file): gives a stable *.supabase.co
// HTTPS origin to lock the browser API key's referrer to, keeps the page in
// this repo, and injects the key/appId from secrets at serve time.
//
// Deploy: supabase functions deploy drive-picker --no-verify-jwt
//   (public - a WebView top-level navigation can't set an auth header)
//
// Secrets:
//   GOOGLE_PICKER_API_KEY  - browser API key, restricted to the Picker API
//                            and the *.supabase.co referrer
//   GOOGLE_PROJECT_NUMBER  - the OAuth client's project number (Picker appId)
//
// postMessage contract (page -> WebView):
//   { type: 'picked', files: [{ id, name, mimeType }] }
//   { type: 'cancel' }
//   { type: 'error', message }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const html = (apiKey: string, appId: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body { margin: 0; height: 100%; background: transparent; }
  </style>
</head>
<body>
<script>
  var API_KEY = ${JSON.stringify(apiKey)};
  var APP_ID = ${JSON.stringify(appId)};

  function post(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  function onApiLoad() {
    try {
      gapi.load('picker', { callback: onPickerLoad, onerror: onGapiError });
    } catch (e) {
      post({ type: 'error', message: 'gapi-load-failed' });
    }
  }

  function onGapiError() {
    post({ type: 'error', message: 'picker-load-failed' });
  }

  function onPickerLoad() {
    var token = window.__ZOLVA_OAUTH_TOKEN;
    if (!token) { post({ type: 'error', message: 'no-token' }); return; }
    if (!API_KEY || !APP_ID) { post({ type: 'error', message: 'server-misconfig' }); return; }
    try {
      // setOwnedByMe(false) so files shared with the user also show.
      var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setOwnedByMe(false)
        .setSelectFolderEnabled(false);
      var picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setDeveloperKey(API_KEY)
        .setAppId(APP_ID)
        .setOAuthToken(token)
        .setOrigin(window.location.protocol + '//' + window.location.host)
        .addView(view)
        .setCallback(pickerCallback)
        .build();
      picker.setVisible(true);
    } catch (e) {
      post({ type: 'error', message: 'picker-build-failed' });
    }
  }

  function pickerCallback(data) {
    var action = data[google.picker.Response.ACTION];
    if (action === google.picker.Action.PICKED) {
      var docs = data[google.picker.Response.DOCUMENTS] || [];
      var files = docs.map(function (d) {
        return {
          id: d[google.picker.Document.ID],
          name: d[google.picker.Document.NAME],
          mimeType: d[google.picker.Document.MIME_TYPE],
        };
      });
      post({ type: 'picked', files: files });
    } else if (action === google.picker.Action.CANCEL) {
      post({ type: 'cancel' });
    }
  }

  window.__onGapiScriptError = function () {
    post({ type: 'error', message: 'api-js-failed' });
  };
</script>
<!-- No Subresource Integrity: apis.google.com/js/api.js is Google's dynamic
     loader with no stable hash; SRI would break the Picker. It is loaded from
     Google's first-party origin, the only valid source for the Picker API. -->
<script async defer src="https://apis.google.com/js/api.js"
  onload="onApiLoad()" onerror="window.__onGapiScriptError()"></script>
</body>
</html>`;

serve((req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  const apiKey = Deno.env.get('GOOGLE_PICKER_API_KEY') ?? '';
  const appId = Deno.env.get('GOOGLE_PROJECT_NUMBER') ?? '';
  return new Response(html(apiKey, appId), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // No caching: the page is tiny and we never want a stale key baked in.
      'cache-control': 'no-store',
    },
  });
});
