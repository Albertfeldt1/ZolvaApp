// Hard gate for production builds: fail fast when TODO placeholders are
// still present in app.json / eas.json so we can't accidentally ship a
// binary where "Privatlivspolitik" opens an Alert saying the URL is not
// configured, or where EAS Submit is pointing at placeholder IDs.
//
// Expo loads app.json first, then calls this function with the merged
// config. We return it unchanged; the side effect is the throw.
//
// To run the guard locally:
//   EAS_BUILD_PROFILE=production npx expo config --type public
// or set ZOLVA_REQUIRE_PROD_CONFIG=1 to force the check in any context.

const appJson = require('./app.json');
const easJson = require('./eas.json');

const isPlaceholder = (value) =>
  typeof value !== 'string' || value.length === 0 || value.startsWith('TODO_');

function collectProblems() {
  const expo = appJson.expo ?? {};
  const problems = [];

  if (isPlaceholder(expo.extra?.eas?.projectId)) {
    problems.push('app.json: expo.extra.eas.projectId — run `eas init` and paste the ID');
  }
  if (isPlaceholder(expo.extra?.privacyPolicyUrl)) {
    problems.push('app.json: expo.extra.privacyPolicyUrl — host the policy and paste the URL');
  }

  const ios = easJson.submit?.production?.ios ?? {};
  if (isPlaceholder(ios.ascAppId)) {
    problems.push('eas.json: submit.production.ios.ascAppId — App Store Connect app ID');
  }
  if (isPlaceholder(ios.appleTeamId)) {
    problems.push('eas.json: submit.production.ios.appleTeamId — Apple Developer team ID');
  }

  return problems;
}

module.exports = ({ config }) => {
  const isProductionBuild =
    process.env.EAS_BUILD_PROFILE === 'production' ||
    process.env.ZOLVA_REQUIRE_PROD_CONFIG === '1';

  if (isProductionBuild) {
    const problems = collectProblems();
    if (problems.length > 0) {
      throw new Error(
        [
          '',
          '❌ Production build blocked — the following values are still TODO placeholders:',
          ...problems.map((p) => `  • ${p}`),
          '',
          'Fill them in and re-run the build. See legal/ for the privacy policy drafts.',
          '',
        ].join('\n'),
      );
    }
  }

  return config;
};
